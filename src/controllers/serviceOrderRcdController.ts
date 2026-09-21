import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';
import { RcdPartItem, RcdServiceItem, RcdInstallment } from '../types/serviceOrder';

export const getRcdByServiceOrderId = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('service_order_rcd')
      .select('*')
      .eq('service_order_id', id)
      .maybeSingle();

    if (error) throw error;
    return res.json(data || null);
  } catch (error: any) {
    console.error('Erro ao buscar RCD:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const saveServiceOrderRcd = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const payload = req.body;

    // 1. Fetch OS details to guarantee reference
    const { data: os, error: osError } = await supabase
      .from('service_orders')
      .select('id, os_number, equipment_id, equipment_name, equipment_asset_number, equipment_model, diagnosis, client_name, client_address, client_contact_name, client_phone')
      .eq('id', id)
      .single();

    if (osError || !os) {
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }

    // 2. Parse & sanitize parts and services
    const parts: RcdPartItem[] = Array.isArray(payload.parts) ? payload.parts : [];
    const services: RcdServiceItem[] = Array.isArray(payload.services) ? payload.services : [];

    const totalParts = parts.reduce((acc, p) => acc + (Number(p.subtotal) || 0), 0);
    const totalServices = services.reduce((acc, s) => acc + (Number(s.subtotal) || 0), 0);
    const totalValue = Number((totalParts + totalServices).toFixed(2));

    const rcdNumber = payload.rcd_number?.trim() || `RCD-${String(os.os_number || '001').padStart(3, '0')}`;

    const rcdDataToSave = {
      service_order_id: id,
      rcd_number: rcdNumber,
      issue_date: payload.issue_date || new Date().toISOString().split('T')[0],
      validity_date: payload.validity_date || null,
      payment_terms: payload.payment_terms || '15 DIAS PARA PAGAMENTO',
      notes: payload.notes || null,
      origin_description: payload.origin_description || 'Contrato de locação',

      client_id: payload.client_id || null,
      client_name: payload.client_name?.trim() || os.client_name || null,
      client_cnpj: payload.client_cnpj?.trim() || null,
      client_address: payload.client_address?.trim() || os.client_address || null,
      client_ie: payload.client_ie?.trim() || null,
      client_contact: payload.client_contact?.trim() || os.client_contact_name || null,
      client_phone: payload.client_phone?.trim() || os.client_phone || null,

      equipment_id: payload.equipment_id || os.equipment_id || null,
      equipment_name: payload.equipment_name || os.equipment_name || null,
      equipment_asset_number: payload.equipment_asset_number || os.equipment_asset_number || null,
      equipment_model: payload.equipment_model || os.equipment_model || null,
      problem_description: payload.problem_description || os.diagnosis || null,

      parts,
      services,

      total_parts: totalParts,
      total_services: totalServices,
      total_value: totalValue,

      payment_method: payload.payment_method || 'Boleto Bancário',
      payment_type: payload.payment_type || 'a_vista',
      installments_count: payload.installments_count || 1,
      installments_data: payload.installments_data || [],

      invoice_number: payload.invoice_number || null,
      signed_document_url: payload.signed_document_url || null,
      signed_at: payload.signed_document_url ? (payload.signed_at || new Date().toISOString()) : null,
      signed_by_name: payload.signed_by_name || null,

      status: payload.status || 'Pendente',
      updated_at: new Date().toISOString(),
      created_by: req.user?.id || null,
    };

    // 3. Upsert RCD
    const { data: savedRcd, error: rcdError } = await supabase
      .from('service_order_rcd')
      .upsert(rcdDataToSave, { onConflict: 'service_order_id' })
      .select('*')
      .single();

    if (rcdError) throw rcdError;

    // 4. Update service_orders reference fields
    await supabase
      .from('service_orders')
      .update({
        rcd_total_value: totalValue,
        signed_rcd_url: payload.signed_document_url || null,
      })
      .eq('id', id);

    return res.json(savedRcd);
  } catch (error: any) {
    console.error('Erro ao salvar RCD:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const launchRcdBills = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // 1. Fetch RCD
    const { data: rcd, error: rcdError } = await supabase
      .from('service_order_rcd')
      .select('*')
      .eq('service_order_id', id)
      .single();

    if (rcdError || !rcd) {
      return res.status(404).json({ error: 'RCD não encontrado para esta ordem de serviço.' });
    }

    if (!rcd.total_value || rcd.total_value <= 0) {
      return res.status(400).json({ error: 'O valor total do RCD deve ser maior que zero para faturamento.' });
    }

    // 2. Fetch OS info
    const { data: os } = await supabase
      .from('service_orders')
      .select('os_number, equipment_name, equipment_asset_number')
      .eq('id', id)
      .single();

    const clientName = rcd.client_name?.trim() || 'Cliente Não Informado';
    const osRef = os?.os_number ? `OS #${os.os_number}` : 'OS';
    const equipRef = os?.equipment_asset_number ? `(${os.equipment_asset_number})` : '';
    const baseDescription = `RCD ${rcd.rcd_number || ''} - ${osRef} ${equipRef}`.trim();
    const invoiceNumber = rcd.invoice_number || rcd.rcd_number || `ND-${String(os?.os_number || '1').padStart(6, '0')}`;

    const isParcelado = rcd.payment_type === 'parcelado' && Array.isArray(rcd.installments_data) && rcd.installments_data.length > 1;

    let createdBillIds: string[] = [];
    let groupId: string | null = null;

    if (isParcelado) {
      groupId = crypto.randomUUID();
      const installments: RcdInstallment[] = rcd.installments_data;
      const totalCount = installments.length;

      const billsToInsert = installments.map((inst, index) => {
        const instNum = inst.installment_number || (index + 1);
        const instGross = Number(inst.gross_value) || 0;
        const instDueDate = inst.due_date ? inst.due_date.split('T')[0] : rcd.issue_date;
        const instDesc = `${baseDescription} - Parcela ${instNum}/${totalCount} - ${clientName}`;

        return {
          origin: 'MANUAL' as const,
          type: 'receivable' as const,
          client_id: rcd.client_id || null,
          rental_invoice_id: null,
          counterparty_name: clientName,
          description: instDesc,
          gross_value: instGross,
          fee_amount: 0,
          net_value: instGross,
          due_date: instDueDate,
          status: 'Pendente',
          bank_raw_snapshot: {
            source: 'RCD_INSTALLMENT',
            group_id: groupId,
            installment_number: instNum,
            total_installments: totalCount,
            total_value: rcd.total_value,
            invoice_number: invoiceNumber,
            service_order_id: id,
            rcd_id: rcd.id,
          },
          created_by: req.user?.id || null,
        };
      });

      const { data: insertedBills, error: insertError } = await supabase
        .from('bills')
        .insert(billsToInsert)
        .select('id');

      if (insertError) throw insertError;
      createdBillIds = (insertedBills || []).map((b: any) => b.id);
    } else {
      const dueDate = (rcd.installments_data?.[0]?.due_date) || rcd.validity_date || rcd.issue_date;
      const singleDesc = `${baseDescription} - ${clientName}`;

      const { data: insertedBill, error: insertError } = await supabase
        .from('bills')
        .insert({
          origin: 'MANUAL',
          type: 'receivable',
          client_id: rcd.client_id || null,
          rental_invoice_id: null,
          counterparty_name: clientName,
          description: singleDesc,
          gross_value: rcd.total_value,
          fee_amount: 0,
          net_value: rcd.total_value,
          due_date: dueDate.split('T')[0],
          status: 'Pendente',
          bank_raw_snapshot: {
            source: 'RCD_BILL',
            total_value: rcd.total_value,
            invoice_number: invoiceNumber,
            service_order_id: id,
            rcd_id: rcd.id,
          },
          created_by: req.user?.id || null,
        })
        .select('id')
        .single();

      if (insertError) throw insertError;
      createdBillIds = [insertedBill.id];
    }

    // 3. Update RCD with bill metadata
    const { data: updatedRcd, error: updateError } = await supabase
      .from('service_order_rcd')
      .update({
        status: 'Faturado',
        billed_at: new Date().toISOString(),
        bill_ids: createdBillIds,
        bill_group_id: groupId,
        invoice_number: invoiceNumber,
      })
      .eq('id', rcd.id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: `Faturamento concluído com sucesso. ${createdBillIds.length} título(s) criado(s) em Contas a Receber.`,
      bill_ids: createdBillIds,
      rcd: updatedRcd,
    });
  } catch (error: any) {
    console.error('Erro ao faturar RCD:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const unlinkRcdBills = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    const { data: rcd, error: rcdError } = await supabase
      .from('service_order_rcd')
      .select('*')
      .eq('service_order_id', id)
      .single();

    if (rcdError || !rcd) {
      return res.status(404).json({ error: 'RCD não encontrado.' });
    }

    if (!rcd.bill_ids || rcd.bill_ids.length === 0) {
      return res.status(400).json({ error: 'Este RCD não possui títulos vinculados em Contas a Receber.' });
    }

    // Check if any bill is already settled
    const { data: existingBills } = await supabase
      .from('bills')
      .select('id, status, is_reconciled')
      .in('id', rcd.bill_ids);

    const hasSettled = existingBills?.some((b: any) => b.is_reconciled || b.status === 'Recebido' || b.status === 'Pago');
    if (hasSettled) {
      return res.status(400).json({
        error: 'Não é possível cancelar o faturamento pois uma ou mais parcelas já foram recebidas/conciliadas no financeiro.',
      });
    }

    // Delete the bills
    await supabase
      .from('bills')
      .delete()
      .in('id', rcd.bill_ids);

    // Update RCD
    const { data: updatedRcd, error: updateError } = await supabase
      .from('service_order_rcd')
      .update({
        status: 'Pendente',
        billed_at: null,
        bill_ids: [],
        bill_group_id: null,
      })
      .eq('id', rcd.id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: 'Faturamento desvinculado com sucesso. Os títulos pendentes foram removidos de Contas a Receber.',
      rcd: updatedRcd,
    });
  } catch (error: any) {
    console.error('Erro ao desvincular faturamento do RCD:', error);
    return res.status(500).json({ error: error.message });
  }
};
