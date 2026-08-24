import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';
import { getStockMovements, recordStockMovement } from '../services/stockMovementService';

export const CATEGORY_PREFIXES: Record<string, string> = {
  'Consumo': 'C',
  'Peça': 'P',
  'Peca': 'P',
  'EPI': 'E',
  'Epi': 'E',
  'Outros': 'O',
  'Outro': 'O',
};

export function getCategoryPrefix(category?: string): string {
  if (!category) return 'P';
  const normalized = category.trim();
  return CATEGORY_PREFIXES[normalized] || normalized.charAt(0).toUpperCase() || 'P';
}

export const getNextInternalCode = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const category = (req.query.category as string) || 'Peça';
    const prefix = getCategoryPrefix(category);

    const { data: existingCodes, error } = await supabase
      .from('parts')
      .select('internal_code')
      .like('internal_code', `${prefix}%`);

    if (error) throw error;

    let maxSeq = 0;
    for (const item of (existingCodes || [])) {
      if (!item.internal_code) continue;
      const rawCode = item.internal_code.trim();
      if (rawCode.toUpperCase().startsWith(prefix)) {
        const numPart = parseInt(rawCode.slice(prefix.length), 10);
        if (!isNaN(numPart) && numPart > maxSeq) {
          maxSeq = numPart;
        }
      }
    }

    const nextSeq = maxSeq + 1;
    const nextCode = `${prefix}${String(nextSeq).padStart(4, '0')}`;

    return res.json({
      category,
      prefix,
      next_seq: nextSeq,
      next_code: nextCode,
    });
  } catch (error: any) {
    console.error('[getNextInternalCode] Erro:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const getAllParts = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { category, search } = req.query;

    let query = supabase
      .from('parts')
      .select('*')
      .order('internal_code', { ascending: true });

    if (category && typeof category === 'string' && category !== 'Todos') {
      query = query.eq('category', category);
    }

    if (search && typeof search === 'string') {
      const term = search.trim();
      query = query.or(`description.ilike.%${term}%,internal_code.ilike.%${term}%,part_number.ilike.%${term}%`);
    }

    const { data, error } = await query;

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getPartById = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('parts')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createPart = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { part_number, internal_code, category, unit } = req.body;

    const insertData = { ...req.body };
    delete insertData.total_value;

    if (!insertData.category) {
      insertData.category = 'Peça';
    }
    if (!insertData.unit) {
      insertData.unit = 'UN';
    }
    if (!insertData.created_by && req.user?.id) {
      insertData.created_by = req.user.id;
    }

    const conditions = [];
    if (part_number) conditions.push(`part_number.eq.${part_number}`);
    if (internal_code) conditions.push(`internal_code.eq.${internal_code}`);

    if (conditions.length > 0) {
      const { data: existingParts, error: searchError } = await supabase
        .from('parts')
        .select('internal_code, description, part_number')
        .or(conditions.join(','));

      if (searchError) throw searchError;

      if (existingParts && existingParts.length > 0) {
        const existing = existingParts[0];
        return res.status(400).json({
          error: `Um material já existe com esses dados:\nCódigo: ${existing.internal_code} | Referência/PN: ${existing.part_number || 'N/A'} | ${existing.description}`
        });
      }
    }

    const { data, error } = await supabase
      .from('parts')
      .insert([insertData])
      .select()
      .single();

    if (error) throw error;

    // Se cadastrado com quantidade > 0, registra a movimentação de ENTRADA inicial
    if (data && Number(data.quantity) > 0) {
      await recordStockMovement(supabase, {
        part_id: data.id,
        movement_type: 'ENTRADA',
        quantity: Number(data.quantity),
        unit_value: Number(data.unit_value) || 0,
        previous_stock: 0,
        new_stock: Number(data.quantity),
        reference_type: 'MANUAL_ADJUSTMENT',
        reference_label: `Cadastro de ${data.internal_code || 'Peça'}`,
        notes: 'Saldo inicial inserido no cadastro do material.',
        created_by: req.user?.id || null,
      });
    }

    return res.status(201).json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updatePart = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const updateData = { ...req.body };
    delete updateData.total_value;

    const { data, error } = await supabase
      .from('parts')
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

export const deletePart = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { error } = await supabase
      .from('parts')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const listMovements = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { part_id, reference_type, limit } = req.query;

    const data = await getStockMovements(supabase, {
      part_id: part_id as string,
      reference_type: reference_type as string,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });

    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};


