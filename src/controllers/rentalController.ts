import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';
import { deleteDealsAndSubDependencies } from './crmController';

const updateEquipmentItemStatus = async (
  supabase: any,
  equipmentId: string,
  billingPeriodEnd?: string | null,
  returnDate?: string | null
) => {
  if (!equipmentId) return;
  const todayStr = new Date().toISOString().split('T')[0];
  const returnDateStr = returnDate ? String(returnDate).split('T')[0] : null;
  const periodEndStr = billingPeriodEnd ? String(billingPeriodEnd).split('T')[0] : null;

  const isPast = (returnDateStr && returnDateStr <= todayStr) || (periodEndStr && periodEndStr < todayStr);

  if (isPast) {
    // Verificar se o equipamento possui alguma outra locação atualmente ativa
    const { data: activeRentals } = await supabase
      .from('rental_invoice_equipments')
      .select('id, billing_period_end, return_date')
      .eq('equipment_id', equipmentId);

    const hasCurrentActive = (activeRentals || []).some((item: any) => {
      const end = (item.return_date || item.billing_period_end || '').split('T')[0];
      return end && end >= todayStr;
    });

    if (!hasCurrentActive) {
      const { data: currentEq } = await supabase.from('equipments').select('status').eq('id', equipmentId).single();
      if (currentEq && currentEq.status === 'Locado') {
        await supabase.from('equipments').update({ status: 'Disponível' }).eq('id', equipmentId);
      }
    }
  } else {
    await supabase.from('equipments').update({ status: 'Locado' }).eq('id', equipmentId);
  }
};

export const getAllInvoices = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 15));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Extract filter params
    const search = (req.query.search as string) || '';
    const billingStatus = (req.query.billing_status as string) || '';
    const reconciliationStatus = (req.query.reconciliation_status as string) || '';
    const dateFrom = (req.query.date_from as string) || '';
    const dateTo = (req.query.date_to as string) || '';
    const valueMin = parseFloat(req.query.value_min as string) || 0;
    const valueMax = parseFloat(req.query.value_max as string) || 0;

    const applyFilters = (q: any) => {
      if (search) {
        q = q.or(
          `client_name.ilike.%${search}%,equipment_name.ilike.%${search}%,asset_number.ilike.%${search}%,invoice_number.ilike.%${search}%`
        );
      }
      if (billingStatus) {
        q = q.eq('billing_status', billingStatus);
      }
      if (reconciliationStatus) {
        q = q.eq('reconciliation_status', reconciliationStatus);
      }
      if (dateFrom) {
        q = q.gte('billing_period_start', dateFrom);
      }
      if (dateTo) {
        q = q.lte('billing_period_start', dateTo);
      }
      if (valueMin > 0) {
        q = q.gte('total_value', valueMin);
      }
      if (valueMax > 0) {
        q = q.lte('total_value', valueMax);
      }
      return q;
    };

    let dataQuery = supabase
      .from('rental_invoices')
      .select('*', { count: 'exact' });
    dataQuery = applyFilters(dataQuery);

    let statsQuery = supabase
      .from('rental_invoices')
      .select('reconciliation_status, total_value');
    statsQuery = applyFilters(statsQuery);

    // Sorting
    const sortBy = (req.query.sort_by as string) || 'billing_period_end';
    const sortOrder = (req.query.sort_order as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc';

    const allowedSortFields: Record<string, string> = {
      billing_period_end: 'billing_period_end',
      billing_period_start: 'billing_period_start',
      client_name: 'client_name',
      equipment_name: 'equipment_name',
      total_value: 'total_value',
      billing_status: 'billing_status',
      created_at: 'created_at',
      invoice_number: 'invoice_number'
    };

    const orderColumn = allowedSortFields[sortBy] || 'billing_period_end';
    const isAscending = sortOrder === 'asc';

    const [dataResult, statsResult] = await Promise.all([
      dataQuery
        .order(orderColumn, { ascending: isAscending, nullsFirst: false })
        .order('created_at', { ascending: false })
        .range(from, to),
      statsQuery
    ]);

    if (dataResult.error) throw dataResult.error;
    if (statsResult.error) throw statsResult.error;

    const statsData = statsResult.data || [];
    const pendingCount = statsData.filter(
      (item: any) => item.reconciliation_status === 'No prazo' || item.reconciliation_status === 'Atrasado' || item.reconciliation_status === 'Pendente'
    ).length;
    const totalValue = statsData.reduce((acc: number, curr: any) => acc + Number(curr.total_value || 0), 0);

    const total = dataResult.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    return res.json({
      data: dataResult.data,
      total,
      page,
      limit,
      totalPages,
      stats: {
        pendingReconciliationCount: pendingCount,
        totalValue,
        monthlyReceivedTotal: totalValue
      }
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getInvoiceById = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data: invoice, error } = await supabase
      .from('rental_invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    // Buscar equipamentos vinculados na nova tabela rental_invoice_equipments
    const { data: items } = await supabase
      .from('rental_invoice_equipments')
      .select('*')
      .eq('rental_invoice_id', id)
      .order('created_at', { ascending: true });

    if (items && items.length > 0) {
      invoice.equipments = items;
    } else if (invoice.equipment_id) {
      // Fallback para locações legadas
      invoice.equipments = [
        {
          id: invoice.id,
          rental_invoice_id: invoice.id,
          equipment_id: invoice.equipment_id,
          equipment_name: invoice.equipment_name,
          equipment_type: invoice.equipment_type,
          equipment_size: invoice.equipment_size,
          asset_number: invoice.asset_number,
          billing_period_start: invoice.billing_period_start,
          billing_period_end: invoice.billing_period_end,
          return_date: invoice.return_date,
          cost_rental: Number(invoice.cost_rental) || 0,
          cost_insurance: Number(invoice.cost_insurance) || 0,
          cost_freight: Number(invoice.cost_freight) || 0,
          cost_rcd: Number(invoice.cost_rcd) || 0,
          cost_third_party: Number(invoice.cost_third_party) || 0,
          cost_training: Number(invoice.cost_training) || 0,
          total_value: Number(invoice.total_value) || 0,
          notes: invoice.notes
        }
      ];
    } else {
      invoice.equipments = [];
    }

    // Buscar ordens de serviço vinculadas a esta locação
    const { data: serviceOrders } = await supabase
      .from('service_orders')
      .select('id, os_number, equipment_id, equipment_asset_number, equipment_name, equipment_model, equipment_serial_number, status, order_type, execution_date, execution_location, created_at')
      .eq('rental_invoice_id', id)
      .order('created_at', { ascending: false });

    invoice.service_orders = serviceOrders || [];

    return res.json(invoice);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const rawEquipments = Array.isArray(req.body.equipments) ? req.body.equipments : [];

    // Validar obrigatoriedade de pelo menos um equipamento
    if (rawEquipments.length === 0 && !req.body.equipment_id) {
      return res.status(400).json({ error: 'A locação deve conter obrigatoriamente um ou mais equipamentos atrelados.' });
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // Validar se equipamentos não disponíveis estão sendo vinculados a períodos que não sejam estritamente no passado
    if (rawEquipments.length > 0) {
      for (const eq of rawEquipments) {
        if (eq.equipment_id) {
          const { data: dbEq } = await supabase
            .from('equipments')
            .select('id, name, asset_number, status')
            .eq('id', eq.equipment_id)
            .single();

          if (dbEq && dbEq.status !== 'Disponível') {
            const effectiveEnd = (eq.return_date || eq.billing_period_end || '').split('T')[0];
            if (!effectiveEnd || effectiveEnd >= todayStr) {
              return res.status(400).json({
                error: `O equipamento "${dbEq.name}" (${dbEq.asset_number || 'S/N'}) está com status "${dbEq.status}". Só é permitido cadastrar locação para equipamentos não disponíveis se o período for retroativo (já finalizado no passado).`
              });
            }
          }
        }
      }
    } else if (req.body.equipment_id) {
      const { data: dbEq } = await supabase
        .from('equipments')
        .select('id, name, asset_number, status')
        .eq('id', req.body.equipment_id)
        .single();

      if (dbEq && dbEq.status !== 'Disponível') {
        const effectiveEnd = (req.body.return_date || req.body.billing_period_end || '').split('T')[0];
        if (!effectiveEnd || effectiveEnd >= todayStr) {
          return res.status(400).json({
            error: `O equipamento "${dbEq.name}" (${dbEq.asset_number || 'S/N'}) está com status "${dbEq.status}". Só é permitido cadastrar locação para equipamentos não disponíveis se o período for retroativo (já finalizado no passado).`
          });
        }
      }
    }

    let cost_rental = 0;
    let cost_insurance = 0;
    let cost_freight = 0;
    let cost_rcd = 0;
    let cost_third_party = 0;
    let cost_training = 0;
    let total_value = 0;
    let billing_period_start = req.body.billing_period_start || '';
    let billing_period_end = req.body.billing_period_end || '';
    let return_date = req.body.return_date || null;
    let equipment_id = req.body.equipment_id || null;
    let equipment_name = req.body.equipment_name || '';
    let equipment_type = req.body.equipment_type || '';
    let asset_number = req.body.asset_number || '';

    if (rawEquipments.length > 0) {
      cost_rental = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_rental) || 0), 0);
      cost_insurance = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_insurance) || 0), 0);
      cost_freight = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_freight) || 0), 0);
      cost_rcd = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_rcd) || 0), 0);
      cost_third_party = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_third_party) || 0), 0);
      cost_training = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_training) || 0), 0);
      total_value = cost_rental + cost_insurance + cost_freight + cost_rcd + cost_third_party + cost_training;

      // Calcular períodos consolidados (mínimo start, máximo end)
      const starts = rawEquipments.map((e: any) => e.billing_period_start).filter(Boolean).sort();
      const ends = rawEquipments.map((e: any) => e.billing_period_end).filter(Boolean).sort();
      if (starts.length > 0) billing_period_start = starts[0];
      if (ends.length > 0) billing_period_end = ends[ends.length - 1];

      // Representação consolidada do primeiro / múltiplos equipamentos
      equipment_id = rawEquipments[0].equipment_id;
      equipment_name = rawEquipments.length === 1 
        ? rawEquipments[0].equipment_name 
        : `${rawEquipments[0].equipment_name || 'Equipamento'} (+${rawEquipments.length - 1} itens)`;
      equipment_type = rawEquipments[0].equipment_type || '';
      asset_number = rawEquipments.map((e: any) => e.asset_number).filter(Boolean).join(', ');
    } else {
      cost_rental = Number(req.body.cost_rental) || 0;
      cost_insurance = Number(req.body.cost_insurance) || 0;
      cost_freight = Number(req.body.cost_freight) || 0;
      cost_rcd = Number(req.body.cost_rcd) || 0;
      cost_third_party = Number(req.body.cost_third_party) || 0;
      cost_training = Number(req.body.cost_training) || 0;
      total_value = cost_rental + cost_insurance + cost_freight + cost_rcd + cost_third_party + cost_training;
    }

    const { equipments: _eq, ...restBody } = req.body;

    const invoiceData = {
      ...restBody,
      billing_method: req.body.billing_method || 'MANUAL',
      equipment_id,
      equipment_name,
      equipment_type,
      asset_number,
      billing_period_start,
      billing_period_end,
      return_date,
      cost_rental,
      cost_insurance,
      cost_freight,
      cost_rcd,
      cost_third_party,
      cost_training,
      total_value
    };

    const { data: createdInvoice, error } = await supabase
      .from('rental_invoices')
      .insert([invoiceData])
      .select()
      .single();

    if (error) throw error;

    // Inserir cada equipamento na tabela rental_invoice_equipments e atualizar status
    if (rawEquipments.length > 0) {
      const itemsToInsert = rawEquipments.map((item: any) => {
        const itemRental = Number(item.cost_rental) || 0;
        const itemInsurance = Number(item.cost_insurance) || 0;
        const itemFreight = Number(item.cost_freight) || 0;
        const itemRcd = Number(item.cost_rcd) || 0;
        const itemThirdParty = Number(item.cost_third_party) || 0;
        const itemTraining = Number(item.cost_training) || 0;
        const itemTotal = itemRental + itemInsurance + itemFreight + itemRcd + itemThirdParty + itemTraining;

        return {
          rental_invoice_id: createdInvoice.id,
          equipment_id: item.equipment_id,
          equipment_name: item.equipment_name || null,
          equipment_type: item.equipment_type || null,
          equipment_size: item.equipment_size || null,
          asset_number: item.asset_number || null,
          billing_period_start: item.billing_period_start || billing_period_start,
          billing_period_end: item.billing_period_end || billing_period_end,
          return_date: item.return_date || null,
          cost_rental: itemRental,
          cost_insurance: itemInsurance,
          cost_freight: itemFreight,
          cost_rcd: itemRcd,
          cost_third_party: itemThirdParty,
          cost_training: itemTraining,
          total_value: itemTotal,
          notes: item.notes || null
        };
      });

      await supabase.from('rental_invoice_equipments').insert(itemsToInsert);

      for (const eq of rawEquipments) {
        await updateEquipmentItemStatus(supabase, eq.equipment_id, eq.billing_period_end, eq.return_date);
      }
    } else if (createdInvoice.equipment_id) {
      // Inserção para caso legado de 1 item
      await supabase.from('rental_invoice_equipments').insert([{
        rental_invoice_id: createdInvoice.id,
        equipment_id: createdInvoice.equipment_id,
        equipment_name: createdInvoice.equipment_name,
        equipment_type: createdInvoice.equipment_type,
        equipment_size: createdInvoice.equipment_size,
        asset_number: createdInvoice.asset_number,
        billing_period_start: createdInvoice.billing_period_start,
        billing_period_end: createdInvoice.billing_period_end,
        return_date: createdInvoice.return_date,
        cost_rental: createdInvoice.cost_rental,
        cost_insurance: createdInvoice.cost_insurance,
        cost_freight: createdInvoice.cost_freight,
        cost_rcd: createdInvoice.cost_rcd,
        cost_third_party: createdInvoice.cost_third_party,
        cost_training: createdInvoice.cost_training,
        total_value: createdInvoice.total_value
      }]);
      await updateEquipmentItemStatus(supabase, createdInvoice.equipment_id, createdInvoice.billing_period_end, createdInvoice.return_date);
    }

    // Disparar lançamento correspondente em `bills` (tipo receivable)
    if (createdInvoice && createdInvoice.client_id && createdInvoice.due_date && total_value > 0) {
      const dueDate = String(createdInvoice.due_date).split('T')[0];

      const { data: existingBills, error: checkError } = await supabase
        .from('bills')
        .select('id')
        .eq('client_id', createdInvoice.client_id)
        .eq('due_date', dueDate)
        .eq('gross_value', total_value);

      if (checkError) {
        console.error('[rentalController] Erro ao consultar duplicidade em bills:', checkError);
      }

      if (!checkError && (!existingBills || existingBills.length === 0)) {
        const billStatus = createdInvoice.reconciliation_status || 'Pendente';
        await supabase
          .from('bills')
          .insert({
            origin: 'MANUAL',
            type: 'receivable',
            rental_invoice_id: createdInvoice.id,
            client_id: createdInvoice.client_id,
            counterparty_name: createdInvoice.client_name || invoiceData.client_name || null,
            description: createdInvoice.invoice_number ? `Fatura de Locação #${createdInvoice.invoice_number}` : 'Fatura de Locação',
            gross_value: total_value,
            fee_amount: 0,
            net_value: total_value,
            due_date: dueDate,
            status: billStatus,
            reconciled_at: billStatus === 'Recebido' ? new Date().toISOString() : null,
            created_by: req.user?.id || null,
            bank_raw_snapshot: {
              is_initial: true,
              period_start: createdInvoice.billing_period_start,
              period_end: createdInvoice.billing_period_end,
              total_value: total_value,
            },
          });
      }
    }

    return res.status(201).json(createdInvoice);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateInvoice = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data: existingInvoice } = await supabase
      .from('rental_invoices')
      .select('id, equipment_id, asset_number, equipment_name, equipment_type')
      .eq('id', id)
      .maybeSingle();

    const rawEquipments = Array.isArray(req.body.equipments) ? req.body.equipments : null;

    if (rawEquipments !== null && rawEquipments.length === 0) {
      return res.status(400).json({ error: 'A locação deve conter obrigatoriamente um ou mais equipamentos atrelados.' });
    }

    let updateData = { ...req.body };
    delete updateData.equipments;

    if (rawEquipments && rawEquipments.length > 0) {
      const cost_rental = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_rental) || 0), 0);
      const cost_insurance = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_insurance) || 0), 0);
      const cost_freight = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_freight) || 0), 0);
      const cost_rcd = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_rcd) || 0), 0);
      const cost_third_party = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_third_party) || 0), 0);
      const cost_training = rawEquipments.reduce((acc: number, eq: any) => acc + (Number(eq.cost_training) || 0), 0);
      const total_value = cost_rental + cost_insurance + cost_freight + cost_rcd + cost_third_party + cost_training;

      const starts = rawEquipments.map((e: any) => e.billing_period_start).filter(Boolean).sort();
      const ends = rawEquipments.map((e: any) => e.billing_period_end).filter(Boolean).sort();

      updateData.cost_rental = cost_rental;
      updateData.cost_insurance = cost_insurance;
      updateData.cost_freight = cost_freight;
      updateData.cost_rcd = cost_rcd;
      updateData.cost_third_party = cost_third_party;
      updateData.cost_training = cost_training;
      updateData.total_value = total_value;
      if (starts.length > 0) updateData.billing_period_start = starts[0];
      if (ends.length > 0) updateData.billing_period_end = ends[ends.length - 1];

      updateData.equipment_id = rawEquipments[0].equipment_id || existingInvoice?.equipment_id || null;
      updateData.equipment_name = rawEquipments.length === 1 
        ? rawEquipments[0].equipment_name 
        : `${rawEquipments[0].equipment_name || 'Equipamento'} (+${rawEquipments.length - 1} itens)`;
      updateData.equipment_type = rawEquipments[0].equipment_type || existingInvoice?.equipment_type || '';
      updateData.asset_number = rawEquipments.map((e: any) => e.asset_number).filter(Boolean).join(', ') || existingInvoice?.asset_number || '';

      // Sincronizar itens na tabela rental_invoice_equipments
      const { data: previousItems } = await supabase
        .from('rental_invoice_equipments')
        .select('*')
        .eq('rental_invoice_id', id);

      const itemsToInsert = rawEquipments.map((item: any, index: number) => {
        const matched = (previousItems || []).find((p: any) => 
          (item.id && p.id === item.id) ||
          (item.asset_number && p.asset_number === item.asset_number) ||
          (item.equipment_id && p.equipment_id === item.equipment_id)
        ) || (previousItems && previousItems[index]);

        const equipId = item.equipment_id || matched?.equipment_id || (index === 0 ? updateData.equipment_id || existingInvoice?.equipment_id : null) || null;
        const assetNum = item.asset_number || matched?.asset_number || (index === 0 ? updateData.asset_number || existingInvoice?.asset_number : null) || null;
        const equipType = item.equipment_type || matched?.equipment_type || (index === 0 ? updateData.equipment_type || existingInvoice?.equipment_type : null) || null;

        const itemRental = Number(item.cost_rental) || 0;
        const itemInsurance = Number(item.cost_insurance) || 0;
        const itemFreight = Number(item.cost_freight) || 0;
        const itemRcd = Number(item.cost_rcd) || 0;
        const itemThirdParty = Number(item.cost_third_party) || 0;
        const itemTraining = Number(item.cost_training) || 0;
        const itemTotal = itemRental + itemInsurance + itemFreight + itemRcd + itemThirdParty + itemTraining;

        return {
          rental_invoice_id: id,
          equipment_id: equipId,
          equipment_name: item.equipment_name || matched?.equipment_name || null,
          equipment_type: equipType,
          equipment_size: item.equipment_size || matched?.equipment_size || null,
          asset_number: assetNum,
          billing_period_start: item.billing_period_start || updateData.billing_period_start,
          billing_period_end: item.billing_period_end || updateData.billing_period_end,
          return_date: item.return_date || matched?.return_date || null,
          cost_rental: itemRental,
          cost_insurance: itemInsurance,
          cost_freight: itemFreight,
          cost_rcd: itemRcd,
          cost_third_party: itemThirdParty,
          cost_training: itemTraining,
          total_value: itemTotal,
          notes: item.notes || matched?.notes || null
        };
      });

      const previousEquipIds = (previousItems || []).map((p: any) => p.equipment_id).filter(Boolean);
      const newEquipIds = itemsToInsert.map((e: any) => e.equipment_id).filter(Boolean);

      // Equipamentos removidos voltam a ficar 'Disponível'
      const removedEquipIds = previousEquipIds.filter((prevId: string) => !newEquipIds.includes(prevId));
      for (const remId of removedEquipIds) {
        await supabase.from('equipments').update({ status: 'Disponível' }).eq('id', remId);
      }

      // Deletar anteriores e inserir novos
      await supabase.from('rental_invoice_equipments').delete().eq('rental_invoice_id', id);
      await supabase.from('rental_invoice_equipments').insert(itemsToInsert);

      // Atualizar status de cada equipamento atual
      for (const eq of itemsToInsert) {
        if (eq.equipment_id) {
          await updateEquipmentItemStatus(supabase, eq.equipment_id, eq.billing_period_end, eq.return_date);
        }
      }
    }

    const { data: updatedInvoice, error } = await supabase
      .from('rental_invoices')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return res.json(updatedInvoice);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteInvoice = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    // Validação de permissão: Apenas Administrador e Diretoria
    const allowedRoles = ['Administrador', 'Diretoria'];
    const userRole = req.profile?.access_level;
    if (!userRole || !allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'Acesso negado: apenas usuários do tipo Administrador e Diretoria têm permissão para excluir locações.'
      });
    }

    const supabase = getSupabaseUserClient(req.token!);

    // 1. Buscar equipamentos vinculados para liberá-los no estoque
    const { data: items } = await supabase
      .from('rental_invoice_equipments')
      .select('equipment_id')
      .eq('rental_invoice_id', id);

    const { data: currentInvoice } = await supabase
      .from('rental_invoices')
      .select('equipment_id, deal_id')
      .eq('id', id)
      .maybeSingle();

    const equipIdsToFree = new Set<string>();
    if (items) {
      items.forEach((i: any) => { if (i.equipment_id) equipIdsToFree.add(i.equipment_id); });
    }
    if (currentInvoice?.equipment_id) {
      equipIdsToFree.add(currentInvoice.equipment_id);
    }

    for (const eqId of equipIdsToFree) {
      await supabase.from('equipments').update({
        status: 'Disponível',
        rental_client_name: null,
        rental_period_start: null,
        rental_period_end: null,
        rental_work_site: null,
        rental_contract_number: null
      }).eq('id', eqId);
    }

    // 2. Excluir contas a receber atreladas à locação em bills
    const { error: billsDeleteError } = await supabase
      .from('bills')
      .delete()
      .eq('rental_invoice_id', id);

    if (billsDeleteError) {
      console.error('[deleteInvoice] Erro ao excluir contas atreladas em bills:', billsDeleteError);
      throw billsDeleteError;
    }

    // 3. Excluir faturas de locação geradas (rental_billing_invoices)
    const { error: faturasDeleteError } = await supabase
      .from('rental_billing_invoices')
      .delete()
      .eq('rental_invoice_id', id);

    if (faturasDeleteError) {
      console.error('[deleteInvoice] Erro ao excluir faturas em rental_billing_invoices:', faturasDeleteError);
      throw faturasDeleteError;
    }

    // 4. Identificar e excluir TODOS os crm_deals relacionados a esta locação e todas as suas subdependências
    const { data: dealsByRental } = await supabase
      .from('crm_deals')
      .select('id')
      .eq('rental_invoice_id', id);

    const { data: contractsByRental } = await supabase
      .from('crm_deal_contracts')
      .select('id, deal_id')
      .eq('rental_invoice_id', id);

    const relatedDealIds = new Set<string>();
    if (currentInvoice?.deal_id) {
      relatedDealIds.add(currentInvoice.deal_id);
    }
    (dealsByRental || []).forEach((d: any) => {
      if (d.id) relatedDealIds.add(d.id);
    });
    (contractsByRental || []).forEach((c: any) => {
      if (c.deal_id) relatedDealIds.add(c.deal_id);
    });

    // Desvincular deal_id na locação para permitir exclusão sem restrições de FK
    await supabase.from('rental_invoices').update({ deal_id: null }).eq('id', id);

    // Excluir contratos atrelados diretamente a esta rental_invoice_id
    await supabase
      .from('crm_deal_contracts')
      .delete()
      .eq('rental_invoice_id', id);

    // Excluir os crm_deals e todas as suas subdependências (contracts, forms, activities, tasks)
    if (relatedDealIds.size > 0) {
      await deleteDealsAndSubDependencies(supabase, Array.from(relatedDealIds));
    }

    // 5. Desvincular Ordens de Serviço atreladas a esta locação
    await supabase
      .from('service_orders')
      .update({ rental_invoice_id: null })
      .eq('rental_invoice_id', id);

    // 6. Excluir itens da locação em rental_invoice_equipments
    await supabase
      .from('rental_invoice_equipments')
      .delete()
      .eq('rental_invoice_id', id);

    // 7. Excluir a locação em rental_invoices
    const { error: invoiceDeleteError } = await supabase
      .from('rental_invoices')
      .delete()
      .eq('id', id);

    if (invoiceDeleteError) throw invoiceDeleteError;

    return res.status(200).json({
      success: true,
      message: 'Locação, contas financeiras e negociações do CRM vinculadas foram excluídas com sucesso.'
    });
  } catch (error: any) {
    console.error('[deleteInvoice] Erro ao excluir locação:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const getOrCreateRentalContractDeal = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // 1. Fetch rental invoice
    const { data: rental, error: rentalError } = await supabase
      .from('rental_invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (rentalError || !rental) {
      return res.status(404).json({ error: 'Fatura de locação não encontrada' });
    }

    // 2. If deal_id already exists in rental or crm_deals links to rental_invoice_id, fetch the deal
    if (rental.deal_id) {
      const { data: existingDeal } = await supabase
        .from('crm_deals')
        .select('*, clients(*)')
        .eq('id', rental.deal_id)
        .maybeSingle();

      if (existingDeal) {
        if (!existingDeal.rental_invoice_id) {
          await supabase.from('crm_deals').update({ rental_invoice_id: rental.id }).eq('id', existingDeal.id);
          existingDeal.rental_invoice_id = rental.id;
        }
        await supabase
          .from('crm_deal_contracts')
          .update({ rental_invoice_id: rental.id })
          .eq('deal_id', existingDeal.id)
          .is('rental_invoice_id', null);

        const { data: contracts } = await supabase
          .from('crm_deal_contracts')
          .select('*')
          .or(`rental_invoice_id.eq.${rental.id},deal_id.eq.${existingDeal.id}`)
          .neq('status', 'Cancelado')
          .order('created_at', { ascending: false });

        const { data: contractForm } = await supabase
          .from('crm_deal_contract_forms')
          .select('*')
          .eq('deal_id', existingDeal.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        return res.json({
          deal: existingDeal,
          contracts: contracts || [],
          contract_form: contractForm || null
        });
      }
    }

    const { data: dealByInvoice } = await supabase
      .from('crm_deals')
      .select('*, clients(*)')
      .eq('rental_invoice_id', rental.id)
      .maybeSingle();

    if (dealByInvoice) {
      if (!rental.deal_id) {
        await supabase
          .from('rental_invoices')
          .update({ deal_id: dealByInvoice.id })
          .eq('id', rental.id);
      }
      await supabase
        .from('crm_deal_contracts')
        .update({ rental_invoice_id: rental.id })
        .eq('deal_id', dealByInvoice.id)
        .is('rental_invoice_id', null);

      const { data: contracts } = await supabase
        .from('crm_deal_contracts')
        .select('*')
        .or(`rental_invoice_id.eq.${rental.id},deal_id.eq.${dealByInvoice.id}`)
        .neq('status', 'Cancelado')
        .order('created_at', { ascending: false });

      const { data: contractForm } = await supabase
        .from('crm_deal_contract_forms')
        .select('*')
        .eq('deal_id', dealByInvoice.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return res.json({
        deal: dealByInvoice,
        contracts: contracts || [],
        contract_form: contractForm || null
      });
    }

    // 3. Find the "Fechado Ganho" stage in the CRM pipelines
    const { data: wonStage } = await supabase
      .from('crm_pipeline_stages')
      .select('id, pipeline_id')
      .eq('is_won', true)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();

    let stageId = wonStage?.id;
    let pipelineId = wonStage?.pipeline_id;

    if (!stageId) {
      const { data: stageByName } = await supabase
        .from('crm_pipeline_stages')
        .select('id, pipeline_id')
        .ilike('name', '%Ganho%')
        .limit(1)
        .maybeSingle();
      stageId = stageByName?.id;
      pipelineId = stageByName?.pipeline_id;
    }

    // 4. Build title: equipment_name + asset_number
    const titleParts = [rental.equipment_name, rental.asset_number].filter(Boolean);
    const title = titleParts.length > 0 ? titleParts.join(' - ') : `Locação Nº ${rental.invoice_number || rental.id.substring(0, 8)}`;

    const expectedCloseDate = rental.billing_period_start
      ? rental.billing_period_start.split('T')[0]
      : (rental.created_at ? rental.created_at.split('T')[0] : new Date().toISOString().split('T')[0]);

    const dealPayload = {
      pipeline_id: pipelineId || null,
      stage_id: stageId || null,
      client_id: rental.client_id || null,
      rental_invoice_id: rental.id,
      title: title,
      value: Number(rental.total_value) || 0,
      expected_close_date: expectedCloseDate,
      closed_at: new Date().toISOString(),
      owner_id: req.user?.id || rental.created_by || null,
      description: `Locação Nº ${rental.invoice_number || rental.id.substring(0, 8)}`,
    };

    const { data: newDeal, error: dealError } = await supabase
      .from('crm_deals')
      .insert(dealPayload)
      .select('*, clients(*)')
      .single();

    if (dealError) throw dealError;

    // 5. Update rental with deal_id
    await supabase
      .from('rental_invoices')
      .update({ deal_id: newDeal.id })
      .eq('id', rental.id);

    // 6. Pre-populate contract form for this deal if not already created
    const { data: existingForm } = await supabase
      .from('crm_deal_contract_forms')
      .select('*')
      .eq('deal_id', newDeal.id)
      .maybeSingle();

    let finalForm = existingForm;

    if (!existingForm) {
      let clientAddressFull = '';
      let clientStateReg = '';
      let clientContactName = '';
      let clientPhone = '';
      if (rental.client_id) {
        const { data: clientData } = await supabase
          .from('clients')
          .select('*')
          .eq('id', rental.client_id)
          .maybeSingle();

        if (clientData) {
          clientContactName = clientData.contact_name || '';
          clientPhone = clientData.phone || '';
          clientStateReg = clientData.state_subscription || '';
          clientAddressFull = [
            clientData.address_street,
            clientData.address_number,
            clientData.address_complement,
            clientData.address_city && clientData.address_state ? `${clientData.address_city}/${clientData.address_state}` : clientData.address_city,
            clientData.address_zip ? `CEP: ${clientData.address_zip}` : ''
          ].filter(Boolean).join(', ');
        }
      }

      // Buscar equipamentos da locação
      const { data: rentalEquips } = await supabase
        .from('rental_invoice_equipments')
        .select('*')
        .eq('rental_invoice_id', rental.id)
        .order('created_at', { ascending: true });

      let equipDescription = '';
      let equipModel = '';
      if (rentalEquips && rentalEquips.length > 0) {
        equipDescription = rentalEquips
          .map((e: any) => `${e.equipment_name || 'Equipamento'} (${e.asset_number || ''})`.trim())
          .join(', ');
        equipModel = Array.from(new Set(rentalEquips.map((e: any) => e.equipment_type).filter(Boolean))).join(', ');
      } else {
        equipDescription = rental.equipment_name ? `${rental.equipment_name} (${rental.asset_number || ''})`.trim() : '';
        equipModel = rental.equipment_type || '';
      }

      let durationDays = 30;
      if (rental.billing_period_start && rental.billing_period_end) {
        const start = new Date(rental.billing_period_start).getTime();
        const end = new Date(rental.billing_period_end).getTime();
        const diff = Math.round((end - start) / (1000 * 60 * 60 * 24));
        if (diff >= 0) durationDays = diff + 1;
      }

      const formPayload = {
        deal_id: newDeal.id,
        contract_date: new Date().toISOString().split('T')[0],
        locatario_company_name: rental.client_name || '',
        locatario_cnpj: rental.cnpj || '',
        locatario_state_registration: clientStateReg,
        locatario_address_full: clientAddressFull,
        equipment_description: equipDescription,
        equipment_model: (rentalEquips && rentalEquips.length > 0)
          ? `[EQUIPMENTS_JSON]:${JSON.stringify(rentalEquips.map((eq: any) => ({
              tempId: eq.id || Math.random().toString(36).substring(2, 9),
              id: eq.id,
              equipment_id: eq.equipment_id || null,
              asset_number: eq.asset_number || null,
              equipment_type: eq.equipment_type || null,
              equipment_name: eq.equipment_name || '',
              equipment_size: eq.equipment_size || '',
              billing_period_start: eq.billing_period_start ? String(eq.billing_period_start).split('T')[0] : (rental.billing_period_start ? String(rental.billing_period_start).split('T')[0] : ''),
              billing_period_end: eq.billing_period_end ? String(eq.billing_period_end).split('T')[0] : (rental.billing_period_end ? String(rental.billing_period_end).split('T')[0] : ''),
              return_date: eq.return_date ? String(eq.return_date).split('T')[0] : null,
              cost_rental: Number(eq.cost_rental) || 0,
              cost_insurance: Number(eq.cost_insurance) || 0,
              cost_freight: Number(eq.cost_freight) || 0,
              cost_rcd: Number(eq.cost_rcd) || 0,
              cost_third_party: Number(eq.cost_third_party) || 0,
              cost_training: Number(eq.cost_training) || 0,
              total_value: Number(eq.total_value) || 0,
              notes: eq.notes || null
            })))}`
          : equipModel,
        contract_duration_days: durationDays,
        period_start: rental.billing_period_start ? rental.billing_period_start.split('T')[0] : null,
        period_end: rental.billing_period_end ? rental.billing_period_end.split('T')[0] : null,
        cost_rental: Number(rental.cost_rental) || 0,
        cost_insurance: Number(rental.cost_insurance) || 0,
        cost_freight: Number(rental.cost_freight) || 0,
        cost_rcd: Number(rental.cost_rcd) || 0,
        cost_third_party: Number(rental.cost_third_party) || 0,
        cost_training: Number(rental.cost_training) || 0,
        cost_total: Number(rental.total_value) || 0,
        billing_interval_days: '28 dias',
        work_site: rental.work_site || '',
        site_contact_name: clientContactName,
        site_contact_phone: clientPhone,
        notes: rental.notes || '',
        form_status: 'Rascunho',
        created_by: req.user?.id
      };

      const { data: createdForm } = await supabase
        .from('crm_deal_contract_forms')
        .insert(formPayload)
        .select()
        .single();

      if (createdForm) {
        finalForm = createdForm;
        await supabase
          .from('crm_deals')
          .update({ contract_form_id: createdForm.id })
          .eq('id', newDeal.id);
      }
    }

    return res.json({ deal: newDeal, contracts: [], contract_form: finalForm || null });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createRentalServiceOrder = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { equipment_id } = req.body;

  try {
    const supabase = getSupabaseUserClient(req.token!);

    // 1. Carregar a locação e dados do cliente
    const { data: rental, error: rentalError } = await supabase
      .from('rental_invoices')
      .select('*, client:clients(*)')
      .eq('id', id)
      .single();

    if (rentalError || !rental) {
      return res.status(404).json({ error: 'Locação não encontrada.' });
    }

    // 2. Identificar e validar o equipamento alvo
    let targetEquipmentId = equipment_id;

    if (!targetEquipmentId) {
      if (rental.equipment_id) {
        targetEquipmentId = rental.equipment_id;
      } else {
        const { data: firstEquip } = await supabase
          .from('rental_invoice_equipments')
          .select('equipment_id')
          .eq('rental_invoice_id', id)
          .limit(1)
          .maybeSingle();

        if (firstEquip) {
          targetEquipmentId = firstEquip.equipment_id;
        }
      }
    }

    if (!targetEquipmentId) {
      return res.status(400).json({ error: 'Nenhum equipamento foi especificado para a Ordem de Serviço.' });
    }

    // 3. Validar se o equipamento pertence à locação
    const isMainEquip = rental.equipment_id === targetEquipmentId;
    let isChildEquip = false;
    if (!isMainEquip) {
      const { data: checkChild } = await supabase
        .from('rental_invoice_equipments')
        .select('id')
        .eq('rental_invoice_id', id)
        .eq('equipment_id', targetEquipmentId)
        .maybeSingle();
      isChildEquip = Boolean(checkChild);
    }

    if (!isMainEquip && !isChildEquip) {
      return res.status(400).json({ error: 'O equipamento informado não pertence a esta locação.' });
    }

    // 4. Buscar dados completos do equipamento
    const { data: equipment, error: equipError } = await supabase
      .from('equipments')
      .select('*')
      .eq('id', targetEquipmentId)
      .single();

    if (equipError || !equipment) {
      return res.status(404).json({ error: 'Equipamento não encontrado no cadastro.' });
    }

    // 5. Montar endereço e dados de contato do cliente / obra
    const client = rental.client || {};
    const addressParts = [
      client.address_street,
      client.address_number,
      client.address_complement,
      client.address_city,
      client.address_state,
      client.address_zip
    ].filter(Boolean).join(', ');

    const fullLocation = rental.work_site
      ? (addressParts ? `${rental.work_site} (${addressParts})` : rental.work_site)
      : (addressParts || '');

    const shortInvoiceRef = rental.invoice_number ? `Locação #${rental.invoice_number}` : `Locação`;

    const osPayload = {
      rental_invoice_id: rental.id,
      equipment_id: equipment.id,
      equipment_asset_number: equipment.asset_number,
      equipment_name: equipment.name,
      equipment_model: equipment.model,
      equipment_serial_number: equipment.serial_number,
      order_type: 'Externa', // Ordens de serviço abertas direto da locação são externas por padrão
      status: 'Aberta',
      execution_date: new Date().toISOString().split('T')[0],
      execution_location: rental.work_site || addressParts || '',
      client_name: client.company_name || rental.client_name || '',
      client_address: fullLocation,
      client_contact_name: client.contact_name || '',
      client_phone: client.phone || '',
      client_request: `Manutenção preventiva/corretiva em campo para o equipamento ${equipment.asset_number || ''} atrelado à ${shortInvoiceRef}.`,
      description: `Ordem de serviço externa gerada a partir da ${shortInvoiceRef}. Obra/Local: ${rental.work_site || 'Não especificado'}.`,
    };

    const { data: newOs, error: osInsertError } = await supabase
      .from('service_orders')
      .insert(osPayload)
      .select()
      .single();

    if (osInsertError) {
      console.error('[createRentalServiceOrder] Erro ao criar OS:', osInsertError);
      throw osInsertError;
    }

    return res.status(201).json(newOs);
  } catch (error: any) {
    console.error('[createRentalServiceOrder] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao gerar ordem de serviço da locação.' });
  }
};

export const getRentalContracts = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // Buscar a locação para obter deal_id
    const { data: rental, error: rentErr } = await supabase
      .from('rental_invoices')
      .select('id, deal_id')
      .eq('id', id)
      .single();

    if (rentErr || !rental) {
      return res.status(404).json({ error: 'Locação não encontrada.' });
    }

    // Se a locação tiver deal_id, sincronizar quaisquer contratos desse deal com a locação
    if (rental.deal_id) {
      await supabase
        .from('crm_deal_contracts')
        .update({ rental_invoice_id: rental.id })
        .eq('deal_id', rental.deal_id)
        .is('rental_invoice_id', null);
    }

    let query = supabase
      .from('crm_deal_contracts')
      .select('*')
      .neq('status', 'Cancelado')
      .order('created_at', { ascending: false });

    if (rental.deal_id) {
      query = query.or(`rental_invoice_id.eq.${rental.id},deal_id.eq.${rental.deal_id}`);
    } else {
      query = query.eq('rental_invoice_id', rental.id);
    }

    const { data: contracts, error } = await query;
    if (error) throw error;

    return res.json(contracts || []);
  } catch (error: any) {
    console.error('[getRentalContracts] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao carregar contratos da locação.' });
  }
};

export const extendInvoice = async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // 1. Obter locação existente
    const { data: rental, error: rentalError } = await supabase
      .from('rental_invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (rentalError || !rental) {
      return res.status(404).json({ error: 'Locação não encontrada.' });
    }

    // 2. Validar que a locação não possui data de devolução já finalizada
    if (rental.return_date) {
      return res.status(400).json({ error: 'Locações que já possuem data de devolução não podem ser prorrogadas.' });
    }

    // 3. Obter lista de extensões/novos períodos do payload
    const rawExtensions = Array.isArray(req.body.extensions)
      ? req.body.extensions
      : Array.isArray(req.body.equipments)
        ? req.body.equipments
        : [];

    if (rawExtensions.length === 0) {
      return res.status(400).json({ error: 'A prorrogação deve conter pelo menos um período de equipamento a adicionar.' });
    }

    // 4. Validar e preparar itens para inserção em rental_invoice_equipments
    const itemsToInsert: any[] = [];
    for (const ext of rawExtensions) {
      if (!ext.billing_period_start || !ext.billing_period_end) {
        return res.status(400).json({ error: 'Data de início e fim são obrigatórias para todos os períodos de prorrogação.' });
      }
      if (ext.billing_period_start > ext.billing_period_end) {
        return res.status(400).json({ error: 'A data de início do período não pode ser posterior à data de término.' });
      }

      const itemRental = Number(ext.cost_rental) || 0;
      const itemInsurance = Number(ext.cost_insurance) || 0;
      const itemFreight = Number(ext.cost_freight) || 0;
      const itemRcd = Number(ext.cost_rcd) || 0;
      const itemThirdParty = Number(ext.cost_third_party) || 0;
      const itemTraining = Number(ext.cost_training) || 0;
      const itemTotal = Math.round((itemRental + itemInsurance + itemFreight + itemRcd + itemThirdParty + itemTraining) * 100) / 100;

      itemsToInsert.push({
        rental_invoice_id: id,
        equipment_id: ext.equipment_id || null,
        equipment_name: ext.equipment_name || null,
        equipment_type: ext.equipment_type || null,
        equipment_size: ext.equipment_size || null,
        asset_number: ext.asset_number || null,
        billing_period_start: ext.billing_period_start,
        billing_period_end: ext.billing_period_end,
        cost_rental: itemRental,
        cost_insurance: itemInsurance,
        cost_freight: itemFreight,
        cost_rcd: itemRcd,
        cost_third_party: itemThirdParty,
        cost_training: itemTraining,
        total_value: itemTotal,
        notes: ext.notes || 'Prorrogação de locação',
      });
    }

    // 5. Inserir novos períodos como novos registros em rental_invoice_equipments
    const { data: insertedItems, error: insertError } = await supabase
      .from('rental_invoice_equipments')
      .insert(itemsToInsert)
      .select();

    if (insertError) {
      console.error('[extendInvoice] Erro ao inserir novo período em rental_invoice_equipments:', insertError);
      throw insertError;
    }

    // 6. Atualizar status dos equipamentos no inventário para 'Locado'
    for (const ext of rawExtensions) {
      if (ext.equipment_id) {
        await updateEquipmentItemStatus(supabase, ext.equipment_id, ext.billing_period_end, null);
      }
    }

    // 7. Calcular total deste novo período / prorrogação
    const extensionTotal = Math.round(itemsToInsert.reduce((acc, it) => acc + (Number(it.total_value) || 0), 0) * 100) / 100;

    // 8. Buscar TODOS os itens da locação para consolidar totais atualizados em rental_invoices
    const { data: allItems, error: allItemsError } = await supabase
      .from('rental_invoice_equipments')
      .select('*')
      .eq('rental_invoice_id', id);

    if (allItemsError) throw allItemsError;

    const consolidatedCostRental = (allItems || []).reduce((acc: number, it: any) => acc + (Number(it.cost_rental) || 0), 0);
    const consolidatedCostInsurance = (allItems || []).reduce((acc: number, it: any) => acc + (Number(it.cost_insurance) || 0), 0);
    const consolidatedCostFreight = (allItems || []).reduce((acc: number, it: any) => acc + (Number(it.cost_freight) || 0), 0);
    const consolidatedCostRcd = (allItems || []).reduce((acc: number, it: any) => acc + (Number(it.cost_rcd) || 0), 0);
    const consolidatedCostThirdParty = (allItems || []).reduce((acc: number, it: any) => acc + (Number(it.cost_third_party) || 0), 0);
    const consolidatedCostTraining = (allItems || []).reduce((acc: number, it: any) => acc + (Number(it.cost_training) || 0), 0);
    const consolidatedTotalValue = Math.round((consolidatedCostRental + consolidatedCostInsurance + consolidatedCostFreight + consolidatedCostRcd + consolidatedCostThirdParty + consolidatedCostTraining) * 100) / 100;

    const allEnds = (allItems || []).map((it: any) => it.billing_period_end).filter(Boolean).sort();
    const maxBillingPeriodEnd = allEnds.length > 0 ? allEnds[allEnds.length - 1] : rental.billing_period_end;

    // 9. Atualizar cabeçalho da locação em rental_invoices
    const { data: updatedInvoice, error: updateInvoiceError } = await supabase
      .from('rental_invoices')
      .update({
        billing_period_end: maxBillingPeriodEnd,
        cost_rental: consolidatedCostRental,
        cost_insurance: consolidatedCostInsurance,
        cost_freight: consolidatedCostFreight,
        cost_rcd: consolidatedCostRcd,
        cost_third_party: consolidatedCostThirdParty,
        cost_training: consolidatedCostTraining,
        total_value: consolidatedTotalValue,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateInvoiceError) throw updateInvoiceError;

    // 10. Lançar registro correspondente em bills com o valor deste novo período
    let createdBill = null;
    if (extensionTotal > 0) {
      const dueDate = req.body.due_date || new Date().toISOString().split('T')[0];
      const billDescription = updatedInvoice.invoice_number
        ? `Prorrogação de Locação #${updatedInvoice.invoice_number}`
        : 'Prorrogação de Locação';

      const extStarts = itemsToInsert.map((it: any) => it.billing_period_start).filter(Boolean).sort();
      const extEnds = itemsToInsert.map((it: any) => it.billing_period_end).filter(Boolean).sort();

      const { data: billData, error: billError } = await supabase
        .from('bills')
        .insert({
          origin: 'MANUAL',
          type: 'receivable',
          rental_invoice_id: updatedInvoice.id,
          client_id: updatedInvoice.client_id || null,
          counterparty_name: updatedInvoice.client_name || null,
          description: billDescription,
          gross_value: extensionTotal,
          fee_amount: 0,
          net_value: extensionTotal,
          due_date: dueDate,
          status: 'Pendente',
          reconciled_at: null,
          created_by: req.user?.id || null,
          bank_raw_snapshot: {
            is_extension: true,
            extension_items: insertedItems || itemsToInsert,
            period_start: extStarts[0] || null,
            period_end: extEnds[extEnds.length - 1] || null,
            total_value: extensionTotal,
          },
        })
        .select()
        .single();

      if (billError) {
        console.error('[extendInvoice] Erro ao lançar conta a receber em bills:', billError);
      } else {
        createdBill = billData;
      }
    }

    // 11. Sincronizar CRM Deal e Form (se existirem) com os novos valores e prazos
    let dealId = updatedInvoice.deal_id;
    if (!dealId) {
      const { data: existingDeal } = await supabase
        .from('crm_deals')
        .select('id')
        .eq('rental_invoice_id', id)
        .maybeSingle();

      if (existingDeal) {
        dealId = existingDeal.id;
        await supabase.from('rental_invoices').update({ deal_id: dealId }).eq('id', id);
      }
    }

    if (dealId) {
      await supabase.from('crm_deals').update({ value: consolidatedTotalValue }).eq('id', dealId);

      const { data: formRecord } = await supabase
        .from('crm_deal_contract_forms')
        .select('id')
        .eq('deal_id', dealId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (formRecord) {
        let durationDays = 30;
        if (updatedInvoice.billing_period_start && maxBillingPeriodEnd) {
          const start = new Date(updatedInvoice.billing_period_start).getTime();
          const end = new Date(maxBillingPeriodEnd).getTime();
          const dayDiff = Math.round((end - start) / (1000 * 60 * 60 * 24));
          if (dayDiff >= 0) durationDays = dayDiff + 1;
        }

        await supabase
          .from('crm_deal_contract_forms')
          .update({
            contract_duration_days: durationDays,
            period_end: maxBillingPeriodEnd ? String(maxBillingPeriodEnd).split('T')[0] : null,
            cost_rental: consolidatedCostRental,
            cost_insurance: consolidatedCostInsurance,
            cost_freight: consolidatedCostFreight,
            cost_rcd: consolidatedCostRcd,
            cost_third_party: consolidatedCostThirdParty,
            cost_training: consolidatedCostTraining,
            cost_total: consolidatedTotalValue,
            updated_by: req.user?.id
          })
          .eq('id', formRecord.id);
      }
    }

    return res.json({
      success: true,
      message: extensionTotal > 0
        ? `Prorrogação realizada com sucesso! Novo período registrado e Conta a Receber de R$ ${extensionTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} lançada.`
        : `Prorrogação realizada com sucesso! Novo período registrado na locação.`,
      rental: updatedInvoice,
      bill: createdBill,
      insertedItems,
      extensionTotal
    });
  } catch (error: any) {
    console.error('[extendInvoice] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao prorrogar fatura de locação.' });
  }
};

export const generateFaturaLocacao = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const {
      rental_invoice_id,
      bill_id,
      tipo = 'INITIAL',
      pdf_url = null,
      period_start = null,
      period_end = null,
      valor_total = 0,
      dados_fatura = null
    } = req.body;

    if (!rental_invoice_id) {
      return res.status(400).json({ error: 'rental_invoice_id é obrigatório.' });
    }

    const invoiceType = (tipo === 'PRORROGACAO' || tipo === 'EXTENSION') ? 'EXTENSION' : 'INITIAL';

    const { data, error } = await supabase.rpc('generate_rental_billing_invoice', {
      p_rental_invoice_id: rental_invoice_id,
      p_bill_id: bill_id || null,
      p_invoice_type: invoiceType,
      p_pdf_url: pdf_url,
      p_period_start: period_start,
      p_period_end: period_end,
      p_total_amount: Number(valor_total) || 0,
      p_invoice_data: dados_fatura,
      p_user_id: req.user?.id || null
    });

    if (error) {
      console.error('[generateFaturaLocacao] Erro RPC:', error);
      const { data: adminData, error: adminError } = await supabaseAdmin.rpc('generate_rental_billing_invoice', {
        p_rental_invoice_id: rental_invoice_id,
        p_bill_id: bill_id || null,
        p_invoice_type: invoiceType,
        p_pdf_url: pdf_url,
        p_period_start: period_start,
        p_period_end: period_end,
        p_total_amount: Number(valor_total) || 0,
        p_invoice_data: dados_fatura,
        p_user_id: req.user?.id || null
      });

      if (adminError) throw adminError;
      const rawFatura = Array.isArray(adminData) ? adminData[0] : adminData;
      const fatura = rawFatura ? { ...rawFatura, numero: rawFatura.invoice_number } : rawFatura;
      return res.json(fatura);
    }

    const rawFatura = Array.isArray(data) ? data[0] : data;
    const fatura = rawFatura ? { ...rawFatura, numero: rawFatura.invoice_number } : rawFatura;
    return res.json(fatura);
  } catch (error: any) {
    console.error('[generateFaturaLocacao] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao gerar fatura de locação.' });
  }
};

export const getFaturasLocacaoByRental = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('rental_billing_invoices')
      .select('*')
      .eq('rental_invoice_id', id)
      .order('sequence_number', { ascending: true });

    if (error) throw error;
    const mapped = (data || []).map((row: any) => ({
      ...row,
      numero: row.invoice_number,
      sequencial: row.sequence_number,
    }));
    return res.json(mapped);
  } catch (error: any) {
    console.error('[getFaturasLocacaoByRental] Erro:', error);
    return res.status(500).json({ error: error.message });
  }
};
