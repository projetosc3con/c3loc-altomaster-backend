import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';

/**
 * Helper to fetch and resolve active rental details for equipment with status 'Locado'.
 * Searches both rental_invoice_equipments (multi-equipment contracts) and rental_invoices (legacy direct).
 */
const fetchActiveRentalsForEquipments = async (supabase: any, equipmentIds: string[]) => {
  if (!equipmentIds || equipmentIds.length === 0) return {};

  // 1. Fetch from rental_invoice_equipments joined with rental_invoices
  const { data: items } = await supabase
    .from('rental_invoice_equipments')
    .select('equipment_id, billing_period_start, billing_period_end, return_date, created_at, rental_invoices(id, invoice_number, client_name, billing_period_start, billing_period_end, work_site, billing_status, return_date, created_at)')
    .in('equipment_id', equipmentIds);

  // 2. Fetch from direct rental_invoices (legacy records)
  const { data: directs } = await supabase
    .from('rental_invoices')
    .select('id, equipment_id, invoice_number, client_name, billing_period_start, billing_period_end, work_site, billing_status, return_date, created_at')
    .in('equipment_id', equipmentIds);

  const candidatesByEq: Record<string, any[]> = {};
  for (const id of equipmentIds) {
    candidatesByEq[id] = [];
  }

  for (const item of (items || [])) {
    const inv: any = item.rental_invoices;
    if (!inv || inv.billing_status === 'Cancelada') continue;
    candidatesByEq[item.equipment_id].push({
      client_name: inv.client_name,
      billing_period_start: item.billing_period_start || inv.billing_period_start,
      billing_period_end: item.billing_period_end || inv.billing_period_end,
      work_site: inv.work_site,
      return_date: item.return_date || inv.return_date,
      invoice_number: inv.invoice_number,
      created_at: item.created_at || inv.created_at
    });
  }

  for (const inv of (directs || [])) {
    if (inv.billing_status === 'Cancelada') continue;
    candidatesByEq[inv.equipment_id].push({
      client_name: inv.client_name,
      billing_period_start: inv.billing_period_start,
      billing_period_end: inv.billing_period_end,
      work_site: inv.work_site,
      return_date: inv.return_date,
      invoice_number: inv.invoice_number,
      created_at: inv.created_at
    });
  }

  const rentalMap: Record<string, any> = {};
  for (const id of equipmentIds) {
    const list = candidatesByEq[id] || [];
    if (list.length > 0) {
      list.sort((a, b) => {
        // Ativas (sem data de retorno) têm prioridade máxima
        const aActive = !a.return_date ? 1 : 0;
        const bActive = !b.return_date ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;

        // Fim de período mais recente/posterior
        const aEnd = a.billing_period_end || '';
        const bEnd = b.billing_period_end || '';
        if (aEnd !== bEnd) return bEnd.localeCompare(aEnd);

        // Início de período mais recente
        const aStart = a.billing_period_start || '';
        const bStart = b.billing_period_start || '';
        return bStart.localeCompare(aStart);
      });

      const best = list[0];
      rentalMap[id] = {
        rental_client_name: best.client_name,
        rental_period_start: best.billing_period_start,
        rental_period_end: best.billing_period_end,
        rental_work_site: best.work_site,
        rental_contract_number: best.invoice_number,
      };
    }
  }

  return rentalMap;
};

export const getAllEquipments = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data: equipments, error } = await supabase
      .from('equipments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Para equipamentos com status 'Locado', buscar informações da locação ativa
    const locadoIds = (equipments || [])
      .filter((e: any) => e.status === 'Locado')
      .map((e: any) => e.id);

    const rentalMap = await fetchActiveRentalsForEquipments(supabase, locadoIds);

    const enriched = (equipments || []).map((eq: any) => ({
      ...eq,
      ...(rentalMap[eq.id] || {}),
    }));

    return res.json(enriched);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getEquipmentById = async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('equipments')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Equipamento não encontrado' });

    let enriched = { ...data };
    if (data.status === 'Locado') {
      const rentalMap = await fetchActiveRentalsForEquipments(supabase, [id]);
      if (rentalMap[id]) {
        enriched = {
          ...enriched,
          ...rentalMap[id],
        };
      }
    }

    return res.json(enriched);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createEquipment = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const insertData = {
      ...req.body,
      created_by: req.user?.id || req.body.created_by || null,
      hour_meter: req.body.hour_meter != null && req.body.hour_meter !== '' ? Number(req.body.hour_meter) : 0,
    };
    const { data, error } = await supabase
      .from('equipments')
      .insert([insertData])
      .select()
      .single();

    if (error) throw error;

    if (data && data.hour_meter != null && Number(data.hour_meter) > 0) {
      await supabase
        .from('equipment_hour_meter_logs')
        .insert({
          equipment_id: data.id,
          hour_meter: Number(data.hour_meter),
          previous_hour_meter: null,
          source_type: 'manual',
          reference_id: data.id,
          notes: 'Horímetro inicial informado no cadastro',
          created_by: req.user?.id || null,
        });
    }

    return res.status(201).json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateEquipment = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const updateData = { ...req.body };
    delete updateData.id;
    delete updateData.created_at;
    delete updateData.updated_at;
    delete updateData.rental_client_name;
    delete updateData.rental_period_start;
    delete updateData.rental_period_end;
    delete updateData.rental_work_site;
    delete updateData.rental_contract_number;

    const userRole = req.profile?.access_level;
    const canEditHourMeter = userRole === 'Administrador' || userRole === 'Diretoria';

    if (updateData.hour_meter !== undefined) {
      if (!canEditHourMeter) {
        // Usuários sem permissão não podem alterar o horímetro
        delete updateData.hour_meter;
      } else if (updateData.hour_meter !== null && updateData.hour_meter !== '') {
        updateData.hour_meter = Number(updateData.hour_meter);
      } else {
        updateData.hour_meter = 0;
      }
    }

    const { data, error } = await supabase
      .from('equipments')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    if (updateData.hour_meter !== undefined && canEditHourMeter && data) {
      const { data: currentEq } = await supabase
        .from('equipments')
        .select('hour_meter')
        .eq('id', id)
        .single();

      const prevHourMeter = currentEq?.hour_meter != null ? Number(currentEq.hour_meter) : null;
      const newHour = Number(updateData.hour_meter);

      if (prevHourMeter === null || Math.abs(prevHourMeter - newHour) > 0.001) {
        await supabase
          .from('equipment_hour_meter_logs')
          .insert({
            equipment_id: id,
            hour_meter: newHour,
            previous_hour_meter: prevHourMeter,
            source_type: 'manual',
            reference_id: id,
            notes: 'Ajuste manual de horímetro',
            created_by: req.user?.id || null,
          });
      }
    }

    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteEquipment = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { error } = await supabase
      .from('equipments')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getEquipmentRentals = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    
    // Buscar em rental_invoice_equipments
    const { data: itemData, error: itemError } = await supabase
      .from('rental_invoice_equipments')
      .select('*, invoice:rental_invoices(*)')
      .eq('equipment_id', id)
      .order('billing_period_start', { ascending: false });

    if (!itemError && itemData && itemData.length > 0) {
      const formatted = itemData.map(item => ({
        ...(item.invoice || {}),
        billing_period_start: item.billing_period_start,
        billing_period_end: item.billing_period_end,
        return_date: item.return_date,
        cost_rental: item.cost_rental,
        total_value: item.total_value,
        equipment_id: item.equipment_id,
        equipment_name: item.equipment_name,
        asset_number: item.asset_number
      }));
      return res.json(formatted);
    }

    // Fallback legado para rental_invoices
    const { data, error } = await supabase
      .from('rental_invoices')
      .select('*')
      .eq('equipment_id', id)
      .order('return_date', { ascending: false, nullsFirst: true });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getEquipmentDocuments = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('equipment_documents')
      .select('*, created_by_profile:users_profiles!created_by(id, full_name), updated_by_profile:users_profiles!updated_by(id, full_name)')
      .eq('equipment_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createEquipmentDocument = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { document_name, file_url, file_name, file_size } = req.body;

    if (!document_name || !file_url) {
      return res.status(400).json({ error: 'Nome do documento e URL do arquivo são obrigatórios.' });
    }

    const { data, error } = await supabase
      .from('equipment_documents')
      .insert([
        {
          equipment_id: id,
          document_name,
          file_url,
          file_name: file_name || null,
          file_size: file_size || null,
          created_by: req.user?.id || null,
          updated_by: req.user?.id || null,
        }
      ])
      .select('*, created_by_profile:users_profiles!created_by(id, full_name)')
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateEquipmentDocument = async (req: AuthRequest, res: Response) => {
  const { docId } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { document_name } = req.body;

    if (!document_name) {
      return res.status(400).json({ error: 'Nome do documento é obrigatório.' });
    }

    const { data, error } = await supabase
      .from('equipment_documents')
      .update({
        document_name,
        updated_by: req.user?.id || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', docId)
      .select('*, created_by_profile:users_profiles!created_by(id, full_name), updated_by_profile:users_profiles!updated_by(id, full_name)')
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteEquipmentDocument = async (req: AuthRequest, res: Response) => {
  const { docId } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { error } = await supabase
      .from('equipment_documents')
      .delete()
      .eq('id', docId);

    if (error) throw error;
    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getEquipmentServiceOrders = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // Buscar o equipamento para obter seu asset_number também
    const { data: eq } = await supabase
      .from('equipments')
      .select('id, asset_number')
      .eq('id', id)
      .single();

    let query = supabase
      .from('service_orders')
      .select('*, executor:users_profiles!executed_by(id, full_name)')
      .order('execution_date', { ascending: false, nullsFirst: false });

    if (eq?.asset_number) {
      query = query.or(`equipment_id.eq.${id},equipment_asset_number.eq.${eq.asset_number}`);
    } else {
      query = query.eq('equipment_id', id);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getEquipmentHourMeterLogs = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('equipment_hour_meter_logs')
      .select('*, created_by_profile:users_profiles!created_by(id, full_name)')
      .eq('equipment_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

