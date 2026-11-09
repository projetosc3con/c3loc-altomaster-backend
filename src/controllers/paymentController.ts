import { Response } from 'express';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';
import { asaasService } from '../services/asaasService';
import { emailService } from '../services/emailService';
import { AsaasChargeRequest, AsaasBillingType, AsaasPaymentResponse } from '../types/asaas';
import { PaymentBreakdown } from '../types/payment';
import { AuthRequest } from '../middleware/auth';

// Status que não contam como "cobrança ativa" para fins de idempotência — uma
// fatura com cobrança CANCELLED/REFUNDED pode receber uma nova cobrança.
const INACTIVE_PAYMENT_STATUSES = ['CANCELLED', 'REFUNDED'];
const CENTS_TOLERANCE = 0.01;

interface FeeSettings {
  asaas_boleto_fee_amount: number | null;
  asaas_pix_fee_percent: number | null;
}

// Regra de negócio: o valor cobrado do cliente no boleto/pix é exatamente o total_value
// da fatura/contrato (sem repasse de taxa). A taxa Asaas é descontada do valor bruto.
function calculateGrossUp(billingType: AsaasBillingType, totalValue: number, settings: FeeSettings) {
  let feeAmount = 0;
  if (billingType === 'BOLETO') {
    feeAmount = settings.asaas_boleto_fee_amount != null ? Number(settings.asaas_boleto_fee_amount) : 0;
  } else if (billingType === 'PIX') {
    feeAmount = settings.asaas_pix_fee_percent != null ? Number((totalValue * settings.asaas_pix_fee_percent).toFixed(2)) : 0;
  }

  // O valor cobrado é exatamente o total da fatura/contrato
  return { feeAmount, chargedValue: totalValue };
}

function buildBreakdown(totalValue: number, feeAmount: number, chargedValue: number, netValue: number | null): PaymentBreakdown {
  return { total_value: totalValue, fee_amount: feeAmount, charged_value: chargedValue, net_value: netValue };
}

export const createChargeForInvoice = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // Sem invoice_items — total_value já vem pronto da raiz do rental_invoice.
    const { data: invoice, error: invoiceError } = await supabase
      .from('rental_invoices')
      .select('*')
      .eq('id', id)
      .single();
    if (invoiceError || !invoice) {
      return res.status(404).json({ error: 'Fatura não encontrada' });
    }

    const { data: settings, error: settingsError } = await supabaseAdmin
      .from('erp_company_settings')
      .select('asaas_api_key, asaas_boleto_fee_amount, asaas_pix_fee_percent, company_name')
      .eq('active', true)
      .single();
    if (settingsError) {
      console.error('[createChargeForInvoice] Erro ao ler erp_company_settings:', settingsError);
    }
    if (!settings?.asaas_api_key) {
      return res.status(400).json({ error: 'Locadora sem chave Asaas configurada' });
    }

    // Idempotência: no máximo uma cobrança ativa por fatura (reforçado por
    // índice único parcial em `payments`, ver migration 20260731130000).
    const fetchActivePayment = () =>
      supabase
        .from('payments')
        .select('*')
        .eq('invoice_id', invoice.id)
        .not('status', 'in', `(${INACTIVE_PAYMENT_STATUSES.join(',')})`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    const { data: existingPayment } = await fetchActivePayment();
    if (existingPayment) {
      let invoiceUrl = existingPayment.invoice_url;
      let bankSlipUrl = existingPayment.bank_slip_url;
      if ((!invoiceUrl || !bankSlipUrl) && existingPayment.asaas_payment_id) {
        // Linha criada antes da migration de gross-up, sem os links
        // persistidos — busca uma única vez no Asaas e faz backfill.
        const fresh = await asaasService.getPayment(settings.asaas_api_key, existingPayment.asaas_payment_id);
        invoiceUrl = fresh.invoiceUrl ?? null;
        bankSlipUrl = fresh.bankSlipUrl ?? null;
        await supabase
          .from('payments')
          .update({ invoice_url: invoiceUrl, bank_slip_url: bankSlipUrl })
          .eq('id', existingPayment.id);
      }

      const charge: AsaasPaymentResponse = {
        id: existingPayment.asaas_payment_id,
        customer: '',
        value: existingPayment.value,
        netValue: existingPayment.net_value,
        billingType: existingPayment.billing_type,
        status: existingPayment.status,
        dueDate: existingPayment.due_date,
        paymentDate: existingPayment.payment_date,
        invoiceUrl,
        bankSlipUrl,
        externalReference: invoice.id,
        deleted: false,
      };

      const feeAmount = Number((existingPayment.value - invoice.total_value).toFixed(2));
      const divergent = existingPayment.net_value_projected != null
        && Math.abs(existingPayment.net_value_projected - invoice.total_value) >= CENTS_TOLERANCE;

      return res.status(200).json({
        invoice_id: invoice.id,
        charge,
        payment: existingPayment,
        breakdown: buildBreakdown(invoice.total_value, feeAmount, existingPayment.value, existingPayment.net_value),
        ...(divergent ? { warning: 'net_value_projected divergente do total_value atual da fatura' } : {}),
      });
    }

    const { data: client } = await supabase
      .from('clients')
      .select('asaas_customer_id, email')
      .eq('id', invoice.client_id)
      .single();
    if (!client?.asaas_customer_id) {
      return res.status(400).json({ error: 'Cliente sem cadastro Asaas (asaas_customer_id)' });
    }

    const billingType = (invoice.payment_method as AsaasBillingType) || 'UNDEFINED';
    const { feeAmount, chargedValue } = calculateGrossUp(billingType, invoice.total_value, settings);

    // Cobrança de valor único — descrição vem da fatura/equipamento.
    const chargeData: AsaasChargeRequest = {
      customer: client.asaas_customer_id,
      billingType,
      value: chargedValue,
      dueDate: invoice.due_date,
      description: `Fatura ${invoice.invoice_number || invoice.id} - ${invoice.equipment_name}`,
      externalReference: invoice.id,
    };

    const charge = await asaasService.createCharge(settings.asaas_api_key, chargeData);

    await supabase
      .from('rental_invoices')
      .update({ billing_status: 'Faturado' })
      .eq('id', invoice.id);

    const projectedNet = Number((invoice.total_value - feeAmount).toFixed(2));

    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        invoice_id: invoice.id,
        client_id: invoice.client_id,
        asaas_payment_id: charge.id,
        billing_type: charge.billingType,
        value: charge.value,
        net_value: charge.netValue,
        net_value_projected: charge.netValue ?? projectedNet,
        invoice_url: charge.invoiceUrl ?? null,
        bank_slip_url: charge.bankSlipUrl ?? null,
        due_date: charge.dueDate,
        payment_date: charge.paymentDate ?? null,
        status: charge.status,
        is_manual_reconciliation: false,
      })
      .select()
      .single();

    if (paymentError) {
      if (paymentError.code === '23505') {
        // Corrida: outra requisição concorrente já criou a cobrança ativa
        // desta fatura entre a checagem de idempotência acima e este insert.
        // A cobrança que acabamos de criar no Asaas (charge.id) fica órfã
        // localmente — logar para reconciliação manual (aceitável para
        // sistema single-tenant de baixo volume, sem lock/transação).
        console.warn(`[createChargeForInvoice] corrida detectada para invoice ${invoice.id}; Asaas payment ${charge.id} não persistido localmente`);
        const { data: winner } = await fetchActivePayment();
        return res.status(200).json({
          invoice_id: invoice.id,
          charge,
          payment: winner,
          breakdown: buildBreakdown(invoice.total_value, feeAmount, chargedValue, winner?.net_value ?? null),
        });
      }
      throw paymentError;
    }

    const divergent = Math.abs(charge.value - invoice.total_value) >= CENTS_TOLERANCE;

    let emailSent = false;
    // [STANDBY - RESEND] Notificações via Resend temporariamente em standby
    /*
    if (client.email) {
      try {
        await emailService.sendBoletoEmail({
          to: client.email,
          clientName: invoice.client_name,
          companyName: settings.company_name || 'C3Loc',
          totalValue: invoice.total_value,
          dueDate: charge.dueDate,
          invoiceUrl: charge.invoiceUrl || charge.bankSlipUrl || '',
          bankSlipUrl: charge.bankSlipUrl,
        });
        emailSent = true;
      } catch (emailError: any) {
        console.error('[createChargeForInvoice] Falha ao enviar e-mail de boleto:', emailError.response?.data || emailError.message);
      }
    }
    */

    return res.status(201).json({
      invoice_id: invoice.id,
      charge,
      payment,
      breakdown: buildBreakdown(invoice.total_value, feeAmount, chargedValue, charge.netValue ?? projectedNet),
      email_sent: emailSent,
      ...(divergent ? { warning: `Valor cobrado no Asaas (${charge.value}) diverge do total da fatura (${invoice.total_value})` } : {}),
    });
  } catch (error: any) {
    console.error('[createChargeForInvoice] Erro:', error.response?.data || error.message);
    return res.status(500).json({ error: error.message, asaas: error.response?.data });
  }
};

// Status de pagamento de uma fatura específica — pode haver mais de um
// registro em `payments` por fatura (histórico de cobranças canceladas), mas
// no máximo uma ativa por vez (ver índice único parcial na migration
// 20260731130000 e a checagem de idempotência em createChargeForInvoice).
export const getInvoicePayments = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('invoice_id', id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return res.json(data);
  } catch (error: any) {
    console.error('[getInvoicePayments] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// Extrato geral de pagamentos, com filtros opcionais via query string.
export const listPayments = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { client_id, status, from, to } = req.query;

    let query = supabase
      .from('payments')
      .select('*, invoice:rental_invoices(invoice_number, client_name)')
      .order('created_at', { ascending: false });

    if (client_id) query = query.eq('client_id', client_id as string);
    if (status) query = query.eq('status', status as string);
    if (from) query = query.gte('due_date', from as string);
    if (to) query = query.lte('due_date', to as string);

    const { data, error } = await query;
    if (error) throw error;

    return res.json(data);
  } catch (error: any) {
    console.error('[listPayments] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
