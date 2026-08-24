import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';

export const getAllEquipments = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data: equipments, error } = await supabase
      .from('equipments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // For equipment with status 'Locado', fetch active rental info
    const locadoIds = (equipments || [])
      .filter((e: any) => e.status === 'Locado')
      .map((e: any) => e.id);

    let rentalMap: Record<string, any> = {};
    if (locadoIds.length > 0) {
      const { data: rentals } = await supabase
        .from('rental_invoices')
        .select('equipment_id, client_name, billing_period_start, billing_period_end, work_site, billing_status')
        .in('equipment_id', locadoIds)
        .neq('billing_status', 'Cancelada')
        .order('billing_period_end', { ascending: false });

      if (rentals) {
        for (const r of rentals) {
          // Keep only the most recent active rental per equipment
          if (!rentalMap[r.equipment_id]) {
            rentalMap[r.equipment_id] = {
              rental_client_name: r.client_name,
              rental_period_start: r.billing_period_start,
              rental_period_end: r.billing_period_end,
              rental_work_site: r.work_site,
            };
          }
        }
      }
    }

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
  const { id } = req.params;
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
      const { data: rental } = await supabase
        .from('rental_invoices')
        .select('client_name, billing_period_start, billing_period_end, work_site, billing_status')
        .eq('equipment_id', id)
        .neq('billing_status', 'Cancelada')
        .order('billing_period_end', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (rental) {
        enriched = {
          ...enriched,
          rental_client_name: rental.client_name,
          rental_period_start: rental.billing_period_start,
          rental_period_end: rental.billing_period_end,
          rental_work_site: rental.work_site,
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
    };
    const { data, error } = await supabase
      .from('equipments')
      .insert([insertData])
      .select()
      .single();

    if (error) throw error;
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

    const { data, error } = await supabase
      .from('equipments')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
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
