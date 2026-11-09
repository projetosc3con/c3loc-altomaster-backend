import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { AsaasWebhookPayload } from '../types/asaas';
import { emitNfseCore } from './fiscalController';
import { emailService } from '../services/emailService';
import { asaasService } from '../services/asaasService';

const FAILED_NFSE_STATUSES = ['ERRO', 'ERROR'];

// Ambos os eventos indicam que o pagamento foi efetuado e atualizam
// payments.status — mas só PAYMENT_RECEIVED garante que o valor já está
// disponível no saldo Asaas (ver markPaymentAsPaid). PAYMENT_CONFIRMED
// (típico em boleto, antes da compensação bancária) só reflete status.
const PAYMENT_STATUS_EVENTS = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'];

export const handleAsaasWebhook = async (req: Request, res: Response) => {
  try {
    const token = req.header('asaas-access-token');
    if (!token || token !== process.env.ASAAS_WEBHOOK_TOKEN) {
      return res.status(403).json({ error: 'Invalid webhook token' });
    }

    const payload = req.body as AsaasWebhookPayload;

    // payment_id é NOT NULL na tabela — eventos de nota fiscal (INVOICE_*)
    // não trazem `payment`, só `invoice`, então cai no id do invoice; sem
    // nenhum dos dois (não deveria acontecer), cai no id do próprio evento
    // pra nunca violar a constraint.
    const { error } = await supabaseAdmin.from('asaas_webhook_logs').insert({
      event_id: payload.id,
      event_type: payload.event,
      payment_id: payload.payment?.id ?? payload.invoice?.id ?? payload.id,
      payload: req.body,
      processed: false,
    });

    // Asaas reenvia entregas; event_id duplicado (unique, postgres 23505) é
    // esperado, não é erro — segue confirmando o recebimento.
    if (error && error.code !== '23505') throw error;

    // Processado de forma síncrona (sem fila/worker no projeto): os updates
    // abaixo são só 2-3 chamadas Supabase, bem dentro do timeout do Asaas.
    // Erro aqui não deve derrubar o 200 (senão o Asaas reentrega em loop) —
    // fica logado no console e a linha correspondente em asaas_webhook_logs
    // permanece com processed=false, sinalizando que precisa de atenção.
    if (PAYMENT_STATUS_EVENTS.includes(payload.event) && payload.payment?.id) {
      try {
        await markPaymentAsPaid(payload);
      } catch (processingError: any) {
        console.error('[handleAsaasWebhook] Erro ao processar baixa:', {
          status: processingError.response?.status,
          data: processingError.response?.data,
          message: processingError.message,
        });
      }
    } else if (payload.event?.startsWith('INVOICE_') && payload.invoice?.id) {
      try {
        await handleInvoiceEvent(payload);
        await supabaseAdmin.from('asaas_webhook_logs').update({ processed: true }).eq('event_id', payload.id);
      } catch (processingError: any) {
        console.error('[handleAsaasWebhook] Erro ao processar evento de nota fiscal:', processingError.message);
      }
    } else if (payload.event?.startsWith('TRANSFER_') && payload.transfer?.id) {
      try {
        await handleTransferEvent(payload);
        await supabaseAdmin.from('asaas_webhook_logs').update({ processed: true }).eq('event_id', payload.id);
      } catch (processingError: any) {
        console.error('[handleAsaasWebhook] Erro ao processar evento de transferência:', processingError.message);
      }
    }

    return res.status(200).json({ received: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

// Eventos de nota fiscal (INVOICE_CREATED/UPDATED/SYNCHRONIZED/AUTHORIZED/
// PROCESSING_CANCELLATION/CANCELED) — sincroniza o status/link da nota local
// com o real do Asaas, e dispara o e-mail pro cliente exatamente no momento
// em que a prefeitura autoriza (é só nesse momento que o pdfUrl existe de
// fato; ver comentário em emitNfseAndNotifyClient sobre a emissão em si não
// ter o link ainda).
async function handleInvoiceEvent(payload: AsaasWebhookPayload) {
  const invoice = payload.invoice!;

  const { data: existing } = await supabaseAdmin
    .from('invoice_nfse')
    .select('id, invoice_id, status')
    .eq('external_id', invoice.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!existing) {
    console.warn(`[handleInvoiceEvent] Nenhuma NFS-e local para external_id=${invoice.id} (evento ${payload.event})`);
    return;
  }

  const wasAlreadyAuthorized = existing.status === 'AUTHORIZED';

  const { error: updateError } = await supabaseAdmin
    .from('invoice_nfse')
    .update({
      status: invoice.status,
      nfse_link: invoice.pdfUrl || null,
      xml_url: invoice.xmlUrl || null,
      return_message: invoice.errors?.map((e) => e.description).join('; ') || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id);
  if (updateError) throw updateError;

  // Só manda e-mail na transição pra AUTHORIZED (não a cada reentrega do
  // mesmo evento, que o Asaas pode fazer).
  const justAuthorized = invoice.status === 'AUTHORIZED' && !wasAlreadyAuthorized;
  if (justAuthorized && invoice.pdfUrl) {
    await sendNfseEmailForInvoice(existing.invoice_id, invoice.pdfUrl);
  }
}

async function markPaymentAsPaid(payload: AsaasWebhookPayload) {
  const paymentPayload = payload.payment!;

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_id, client_id, due_date, net_value_projected')
    .eq('asaas_payment_id', paymentPayload.id)
    .maybeSingle();

  if (!payment) {
    console.warn(`[handleAsaasWebhook] Nenhum payment local para asaas_payment_id=${paymentPayload.id}`);
    return;
  }

  // Conciliação: net_value_projected foi calculado na criação da cobrança
  // (gross-up com a taxa configurada em erp_company_settings). Se o net_value
  // real do pagamento divergir, a taxa configurada provavelmente ficou
  // desatualizada — só loga, não bloqueia a baixa do pagamento.
  const realNetValue = paymentPayload.netValue ?? null;
  if (payment.net_value_projected != null && realNetValue != null
      && Math.abs(realNetValue - payment.net_value_projected) >= 0.01) {
    console.warn(
      `[handleAsaasWebhook] net_value divergente no pagamento ${payment.id}: ` +
      `projetado=${payment.net_value_projected} real=${realNetValue} ` +
      `(verificar taxa em erp_company_settings)`
    );
  }

  // Status real do Asaas (ex: RECEIVED, CONFIRMED) — mesmo padrão já usado em
  // createChargeForInvoice (paymentController.ts), mantém granularidade em
  // vez de um valor fixo como 'PAID'.
  //
  // rental_invoices.billing_status NÃO é tocado aqui: é o enum
  // billing_status_type (Pendente/Faturado/Emitida/Cancelada), que hoje não
  // tem nenhum valor para "pago" — decisão do usuário foi não alterar esse
  // enum por ora. Quem precisa saber se uma fatura foi paga consulta
  // payments.status pelo invoice_id.
  const { error: paymentError } = await supabaseAdmin
    .from('payments')
    .update({
      status: paymentPayload.status,
      payment_date: paymentPayload.paymentDate ?? null,
      net_value: realNetValue,
    })
    .eq('id', payment.id);
  if (paymentError) throw paymentError;

  // Lançamento em bills só quando o valor está de fato disponível no saldo
  // Asaas (PAYMENT_RECEIVED) — PAYMENT_CONFIRMED não garante saldo (ver doc
  // oficial Asaas: "saldo ainda não foi disponibilizado").
  if (payload.event === 'PAYMENT_RECEIVED') {
    await createBillFromPayment(payment, payload, realNetValue);
  }

  // NF-e continua no primeiro evento pago (CONFIRMED ou RECEIVED) — pedido
  // original do Victor; a própria função já é idempotente (pula se já existe
  // uma NFS-e não-falha pra essa fatura), então repetir a chamada quando
  // RECEIVED chegar depois de CONFIRMED não duplica nada.
  await emitNfseAndNotifyClient(payment);

  const { error: logError } = await supabaseAdmin
    .from('asaas_webhook_logs')
    .update({ processed: true })
    .eq('event_id', payload.id);
  if (logError) throw logError;
}

// Registro em bills a partir de um pagamento confirmado no Asaas, seguido do
// pedido de repasse (POST /v3/transfers no próprio Asaas — não no BB: o
// dinheiro do cliente está no saldo do Asaas, e só o Asaas pode mandar esse
// saldo pra fora; uma transferência PIX de saída do BB não tem como "puxar"
// um valor que nunca esteve lá — ver INTEGRACOES_ASAAS_BB.md §1.1 sobre o
// repasse via bbPixService removido). Roda depois da baixa em payments e
// antes de marcar o log como processed=true: se o INSERT em bills falhar, o
// log fica com processed=false (sinaliza atenção manual).
//
// O pedido de transferência em si é best-effort e NÃO bloqueia o resto do
// fluxo (NFS-e) se falhar — erro só é logado. `bank_transaction_date`/
// `pix_end_to_end_id` nascem null e só são preenchidos quando o evento
// TRANSFER_DONE chegar (ver handleTransferEvent) ou, pra recebimentos fora
// desse fluxo, quando a conciliação bancária real bater contra o extrato do
// BB (bankReconciliationController).
//
// Idempotência: só PAYMENT_RECEIVED chama essa função (ver markPaymentAsPaid),
// mas o Asaas pode reentregar o mesmo evento mais de uma vez - o check por
// payment_id evita uma segunda linha em bills (e um segundo pedido de
// transferência) numa reentrega.
async function createBillFromPayment(
  payment: { id: string; invoice_id: string; client_id: string; due_date: string },
  payload: AsaasWebhookPayload,
  realNetValue: number | null
) {
  const { data: existingBill } = await supabaseAdmin
    .from('bills')
    .select('id')
    .eq('payment_id', payment.id)
    .maybeSingle();

  if (existingBill) {
    console.log(`[createBillFromPayment] bill ja existe para payment_id=${payment.id} (event ${payload.event} reenviado) - pulando`);
    return;
  }

  const paymentPayload = payload.payment!;
  const netValue = realNetValue ?? paymentPayload.netValue ?? paymentPayload.value;

  const { data: bill, error: billError } = await supabaseAdmin
    .from('bills')
    .insert({
      origin: 'ASAAS',
      type: 'receivable',
      rental_invoice_id: payment.invoice_id,
      payment_id: payment.id,
      client_id: payment.client_id,
      gross_value: paymentPayload.value,
      net_value: netValue,
      fee_amount: paymentPayload.value - netValue,
      due_date: payment.due_date,
      pix_end_to_end_id: null,
      bank_transaction_date: null,
      bank_raw_snapshot: null,
      asaas_transfer_id: null,
      status: 'Recebido',
      reconciled_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (billError) throw billError;

  try {
    await requestTransfer(bill.id, payment.id, netValue);
  } catch (transferError: any) {
    console.error(`[createBillFromPayment] Falha ao pedir repasse pro bill ${bill.id}:`, {
      status: transferError.response?.status,
      data: transferError.response?.data,
      message: transferError.message,
    });
  }
}

// Pede ao Asaas pra transferir o valor líquido pra chave Pix cadastrada em
// erp_company_settings.bank_pix_key. A resposta costuma vir PENDING/
// BANK_PROCESSING (não DONE) — só grava o id da transferência no bill pra
// permitir: (a) o endpoint de validação de saque reconhecer o pedido como
// nosso (ver asaasTransferApprovalController.ts) e (b) o evento TRANSFER_DONE
// achar o bill certo depois.
async function requestTransfer(billId: string, paymentId: string, netValue: number) {
  const { data: settings } = await supabaseAdmin
    .from('erp_company_settings')
    .select('asaas_api_key, bank_pix_key, bank_pix_key_type')
    .eq('active', true)
    .single();

  if (!settings?.asaas_api_key || !settings?.bank_pix_key || !settings?.bank_pix_key_type) {
    console.warn(`[requestTransfer] erp_company_settings sem asaas_api_key/bank_pix_key/bank_pix_key_type configurados — pulando repasse do bill ${billId} (ver sql/2026-08-20_bills_asaas_transfer.sql)`);
    return;
  }

  const transfer = await asaasService.createTransfer(settings.asaas_api_key, {
    value: netValue,
    pixAddressKey: settings.bank_pix_key,
    pixAddressKeyType: settings.bank_pix_key_type,
    description: `Repasse locação RentDesk - payment ${paymentId}`,
    externalReference: paymentId,
  });

  const { error: updateError } = await supabaseAdmin
    .from('bills')
    .update({
      asaas_transfer_id: transfer.id,
      // Na hipótese (rara) de já vir DONE na resposta síncrona, grava direto
      // — senão fica pro evento TRANSFER_DONE atualizar depois.
      ...(transfer.status === 'DONE'
        ? {
            pix_end_to_end_id: transfer.endToEndIdentifier ?? null,
            bank_transaction_date: transfer.effectiveDate ?? null,
            bank_raw_snapshot: transfer,
          }
        : {}),
    })
    .eq('id', billId);
  if (updateError) throw updateError;
}

// Eventos de transferência (TRANSFER_CREATED/PENDING/IN_BANK_PROCESSING/
// BLOCKED/DONE/FAILED/CANCELLED) — só TRANSFER_DONE de fato marca o bill como
// conciliado com o banco; os demais só são logados (mesmo padrão de
// visibilidade usado pros outros gaps documentados neste arquivo).
async function handleTransferEvent(payload: AsaasWebhookPayload) {
  const transfer = payload.transfer!;

  const { data: bill } = await supabaseAdmin
    .from('bills')
    .select('id')
    .eq('asaas_transfer_id', transfer.id)
    .maybeSingle();

  if (!bill) {
    console.warn(`[handleTransferEvent] Nenhum bill local para asaas_transfer_id=${transfer.id} (evento ${payload.event})`);
    return;
  }

  if (payload.event === 'TRANSFER_DONE') {
    const { error } = await supabaseAdmin
      .from('bills')
      .update({
        pix_end_to_end_id: transfer.endToEndIdentifier ?? null,
        bank_transaction_date: transfer.effectiveDate ?? null,
        bank_raw_snapshot: transfer,
        reconciled_at: new Date().toISOString(),
      })
      .eq('id', bill.id);
    if (error) throw error;
    return;
  }

  if (['TRANSFER_FAILED', 'TRANSFER_CANCELLED', 'TRANSFER_BLOCKED'].includes(payload.event)) {
    // bills.status tem CHECK constraint fixo (Pendente/Atrasado/Recebido/
    // Divergente/No prazo — ver comentário em billController.createBill) sem
    // nenhum valor pra "falha no repasse", então não dá pra sinalizar isso
    // no status sem violar a constraint — fica só o log mesmo, pra
    // acompanhamento manual (mesmo tipo de gap já documentado nos outros
    // eventos deste webhook).
    console.warn(`[handleTransferEvent] Repasse falhou/cancelado pro bill ${bill.id} (evento ${payload.event}): ${transfer.failReason ?? 'sem motivo informado'}`);
  }
}

// Emite a NFS-e automaticamente (ou envia a Fatura de Locação de Bens Móveis)
// quando o pagamento é confirmado e notifica o cliente por e-mail.
async function emitNfseAndNotifyClient(payment: { invoice_id: string; client_id: string }) {
  const { data: invoice } = await supabaseAdmin
    .from('rental_invoices')
    .select('id, client_id, equipment_name, client_name, document_type, invoice_number, total_value, fatura_pdf_url')
    .eq('id', payment.invoice_id)
    .single();

  if (!invoice) return;

  // Se o documento fiscal configurado for FATURA_LOCACAO, envia a Fatura de Locação e não emite NFS-e municipal
  if (invoice.document_type === 'FATURA_LOCACAO') {
    console.log(`[emitNfseAndNotifyClient] Fatura ${payment.invoice_id} configurada como FATURA_LOCACAO - enviando e-mail de fatura e pulando NFS-e.`);
    await sendFaturaEmailForInvoice(invoice);
    return;
  }

  const { data: existingNfse } = await supabaseAdmin
    .from('invoice_nfse')
    .select('status')
    .eq('invoice_id', payment.invoice_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingNfse && !FAILED_NFSE_STATUSES.includes(existingNfse.status)) {
    console.log(`[emitNfseAndNotifyClient] NFS-e ja emitida (status=${existingNfse.status}) para invoice ${payment.invoice_id} - pulando`);
    return;
  }

  let nfse;
  try {
    ({ nfse } = await emitNfseCore(supabaseAdmin, payment.invoice_id));
  } catch (error: any) {
    // Mesmo tratamento de fallback do emitNfse (fiscalController.ts): registra
    // a falha em invoice_nfse pra aparecer no card "Nota Fiscal" da locação
    // (com o botão "Tentar Emitir Novamente"), em vez de só no log do webhook.
    await supabaseAdmin.from('invoice_nfse').insert({
      invoice_id: payment.invoice_id,
      gateway: 'asaas',
      status: 'ERRO',
      return_message: error.response?.data?.errors?.[0]?.description || error.message,
    });
    throw error;
  }

  // O link do PDF só fica disponível depois que a prefeitura autoriza a nota
  // (assíncrono) — na emissão o status normalmente ainda é SCHEDULED, sem
  // nfse_link. Sem worker/cron no projeto para reconsultar depois, o e-mail
  // só é disparado se o link já vier pronto; senão o cliente confere pela
  // tela (botão "Atualizar Status" em RentalEdit.tsx).
  if (!nfse.nfse_link) {
    console.log(`[emitNfseAndNotifyClient] NFS-e emitida (status=${nfse.status}) mas sem nfse_link ainda para invoice ${payment.invoice_id} - aguardando evento INVOICE_AUTHORIZED do webhook pra mandar o e-mail`);
    return;
  }

  await sendNfseEmailForInvoice(payment.invoice_id, nfse.nfse_link);
}

// Dispara e-mail com a Fatura de Locação de Bens Móveis
async function sendFaturaEmailForInvoice(invoice: any) {
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('email, company_name')
    .eq('id', invoice.client_id)
    .single();
  if (!client?.email) return;

  const { data: settings } = await supabaseAdmin
    .from('erp_company_settings')
    .select('company_name')
    .eq('active', true)
    .single();
  const companyName = settings?.company_name || 'C3Loc';

  // [STANDBY - RESEND] Envio de fatura de locação por e-mail temporariamente em standby
  /*
  await emailService.sendFaturaLocacaoEmail({
    to: client.email,
    clientName: client.company_name || invoice.client_name || 'Cliente',
    companyName,
    equipmentDescription: invoice.equipment_name || 'Equipamento',
    faturaNumber: invoice.invoice_number,
    totalValue: Number(invoice.total_value) || 0,
    faturaLink: invoice.fatura_pdf_url || undefined,
  });
  */
}

// Compartilhado entre a emissão síncrona (emitNfseAndNotifyClient, quando o
// pdfUrl já vem pronto na resposta de criação) e o evento assíncrono
// INVOICE_AUTHORIZED (handleInvoiceEvent, quando o link só fica disponível
// depois da autorização da prefeitura).
async function sendNfseEmailForInvoice(invoiceId: string, nfseLink: string) {
  const { data: invoice } = await supabaseAdmin
    .from('rental_invoices')
    .select('client_id, equipment_name, client_name')
    .eq('id', invoiceId)
    .single();
  if (!invoice) return;

  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('email, company_name')
    .eq('id', invoice.client_id)
    .single();
  if (!client?.email) return;

  const { data: settings } = await supabaseAdmin
    .from('erp_company_settings')
    .select('company_name')
    .eq('active', true)
    .single();
  const companyName = settings?.company_name || 'C3Loc';

  try {
    // [STANDBY - RESEND] Envio de NFS-e por e-mail temporariamente em standby
    /*
    await emailService.sendNfseEmail({
      to: client.email,
      clientName: client.company_name || invoice.client_name || 'Cliente',
      companyName,
      equipmentDescription: invoice.equipment_name || 'Equipamento',
      nfseLink,
    });
    */
  } catch (emailError: any) {
    console.error('[sendNfseEmailForInvoice] Falha ao enviar e-mail de NFS-e:', emailError.response?.data || emailError.message);
  }
}
