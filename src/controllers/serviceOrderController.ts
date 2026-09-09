import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';
import { recordStockMovement } from '../services/stockMovementService';

const SERVICE_ORDER_SELECT = '*, service_order_parts(*, parts(*)), service_order_labor(*), executor:users_profiles!executed_by(id, full_name)';

export const getAllServiceOrders = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('service_orders')
      .select(SERVICE_ORDER_SELECT)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getServiceOrderById = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('service_orders')
      .select(SERVICE_ORDER_SELECT)
      .eq('id', id)
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createServiceOrder = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { parts, labor, ...osData } = req.body;

    // Remove read-only / relation fields
    delete osData.id;
    delete osData.os_number;
    delete osData.created_at;
    delete osData.updated_at;
    delete osData.service_order_parts;
    delete osData.service_order_labor;
    delete osData.executor;
    delete osData.equipment;
    delete osData.equipments;

    // 0. Validate parts stock availability before doing anything
    if (parts && Array.isArray(parts) && parts.length > 0) {
        for (const p of parts) {
            const { data: part, error: partError } = await supabase
                .from('parts')
                .select('quantity, description')
                .eq('id', p.part_id)
                .single();
            
            if (partError || !part) {
                return res.status(404).json({ error: `Peça com ID ${p.part_id} não encontrada.` });
            }

            if ((part.quantity || 0) < p.quantity_used) {
                return res.status(400).json({ 
                    error: `Estoque insuficiente para a peça "${part.description}". Estoque disponível: ${part.quantity || 0}, solicitado: ${p.quantity_used}.` 
                });
            }
        }
    }

    // 0.1 Validate equipment status: if "Locado", OS can only be opened with a valid rental_invoice_id
    if (osData.equipment_id) {
      const { data: equip, error: eqErr } = await supabase
        .from('equipments')
        .select('id, name, asset_number, status')
        .eq('id', osData.equipment_id)
        .single();

      if (eqErr || !equip) {
        return res.status(404).json({ error: 'Equipamento não encontrado.' });
      }

      if (equip.status === 'Locado') {
        if (!osData.rental_invoice_id) {
          return res.status(400).json({
            error: `O equipamento "${equip.asset_number || equip.name}" está com status "Locado". Ordens de serviço para equipamentos locados só podem ser abertas diretamente a partir da respectiva locação.`
          });
        }

        // Validar se o equipamento pertence à locação informada
        const { data: mainRental } = await supabase
          .from('rental_invoices')
          .select('id, equipment_id')
          .eq('id', osData.rental_invoice_id)
          .single();

        let isLinked = mainRental?.equipment_id === equip.id;
        if (!isLinked) {
          const { data: childEquip } = await supabase
            .from('rental_invoice_equipments')
            .select('id')
            .eq('rental_invoice_id', osData.rental_invoice_id)
            .eq('equipment_id', equip.id)
            .maybeSingle();
          isLinked = Boolean(childEquip);
        }

        if (!isLinked) {
          return res.status(400).json({
            error: `O equipamento locado "${equip.asset_number || equip.name}" não pertence à locação informada.`
          });
        }
      }
    }

    // 1. Create the Service Order
    const { data: os, error: osError } = await supabase
      .from('service_orders')
      .insert([osData])
      .select()
      .single();

    if (osError) throw osError;

    // 2. Update equipment status based on OS status (only for equipment not linked to active rental)
    if (osData.equipment_id && !osData.rental_invoice_id) {
        const isAvailable = osData.status === 'Concluída' || osData.status === 'Encerrada com pendências' || osData.status === 'Cancelada';
        await supabase
            .from('equipments')
            .update({ status: isAvailable ? 'Disponível' : 'Em Manutenção' })
            .eq('id', osData.equipment_id);
    }

    // 3. Add parts if provided
    if (parts && Array.isArray(parts) && parts.length > 0) {
        const partsToInsert = parts.map((p: any) => ({
            service_order_id: os.id,
            part_id: p.part_id,
            quantity_used: p.quantity_used,
            unit_value_at_use: p.unit_value_at_use,
            was_used: p.was_used !== undefined ? p.was_used : true
        }));

        const { error: partsError } = await supabase
            .from('service_order_parts')
            .insert(partsToInsert);

        if (partsError) throw partsError;

        // 4. Update parts stock and record SAIDA audit log
        for (const p of parts) {
            const { data: part } = await supabase
                .from('parts')
                .select('id, quantity, unit_value, description, internal_code')
                .eq('id', p.part_id)
                .single();
            if (part) {
                const prevStock = Number(part.quantity) || 0;
                const qtyUsed = Number(p.quantity_used) || 0;
                const newStock = prevStock - qtyUsed;

                await supabase
                    .from('parts')
                    .update({ quantity: newStock })
                    .eq('id', p.part_id);

                await recordStockMovement(supabase, {
                    part_id: p.part_id,
                    movement_type: 'SAIDA',
                    quantity: qtyUsed,
                    unit_value: p.unit_value_at_use || part.unit_value || 0,
                    previous_stock: prevStock,
                    new_stock: newStock,
                    reference_type: 'SERVICE_ORDER',
                    reference_id: os.id,
                    reference_label: `OS #${os.os_number || os.id.slice(0, 8)}`,
                    notes: `Aplicação de material na OS #${os.os_number || ''} (${osData.equipment_name || 'Equipamento'}).`,
                    created_by: req.user?.id || null,
                });
            }
        }
    }

    // 5. Add labor entries if provided
    if (labor && Array.isArray(labor) && labor.length > 0) {
        const laborToInsert = labor.map((l: any) => ({
            service_order_id: os.id,
            technician_name: l.technician_name,
            labor_date: l.labor_date || null,
            start_time: l.start_time || null,
            end_time: l.end_time || null,
            labor_type: l.labor_type || 'T'
        }));

        const { error: laborError } = await supabase
            .from('service_order_labor')
            .insert(laborToInsert);

        if (laborError) throw laborError;
    }

    return res.status(201).json(os);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateServiceOrder = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    try {
        const supabase = getSupabaseUserClient(req.token!);
        const { parts, labor, ...osData } = req.body;

        // Remove read-only / relation fields
        delete osData.id;
        delete osData.os_number;
        delete osData.created_at;
        delete osData.updated_at;
        delete osData.service_order_parts;
        delete osData.service_order_labor;
        delete osData.executor;
        delete osData.equipment;
        delete osData.equipments;

        // 0. Validate and calculate stock adjustments
        let oldQuantities: Record<string, number> = {};
        let newQuantities: Record<string, number> = {};
        let affectedPartIds: string[] = [];
        let stockQuantities: Record<string, { quantity: number; description: string }> = {};

        if (parts && Array.isArray(parts)) {
            // Fetch current parts allocated to this OS
            const { data: oldParts, error: oldPartsError } = await supabase
                .from('service_order_parts')
                .select('part_id, quantity_used')
                .eq('service_order_id', id);

            if (oldPartsError) throw oldPartsError;

            if (oldParts) {
                for (const op of oldParts) {
                    oldQuantities[op.part_id] = op.quantity_used || 0;
                }
            }

            for (const np of parts) {
                newQuantities[np.part_id] = np.quantity_used || 0;
            }

            affectedPartIds = Array.from(new Set([
                ...Object.keys(oldQuantities),
                ...Object.keys(newQuantities)
            ]));

            if (affectedPartIds.length > 0) {
                const { data: partsInDb, error: dbError } = await supabase
                    .from('parts')
                    .select('id, quantity, description')
                    .in('id', affectedPartIds);
                
                if (dbError) throw dbError;

                if (partsInDb) {
                    for (const pdb of partsInDb) {
                        stockQuantities[pdb.id] = {
                            quantity: pdb.quantity || 0,
                            description: pdb.description || 'Peça sem descrição'
                        };
                    }
                }

                // Check stock for additions/increases
                for (const partId of affectedPartIds) {
                    const oldQty = oldQuantities[partId] || 0;
                    const newQty = newQuantities[partId] || 0;
                    const diff = newQty - oldQty;

                    if (diff > 0) {
                        const dbPart = stockQuantities[partId];
                        const currentStock = dbPart ? dbPart.quantity : 0;
                        const partDesc = dbPart ? dbPart.description : `ID: ${partId}`;

                        if (currentStock < diff) {
                            return res.status(400).json({
                                error: `Estoque insuficiente para a peça "${partDesc}". Estoque disponível: ${currentStock}, necessário adicional: ${diff}.`
                            });
                        }
                    }
                }
            }
        }

        // 1. Update the Service Order
        const { data: os, error: osError } = await supabase
            .from('service_orders')
            .update(osData)
            .eq('id', id)
            .select()
            .single();

        if (osError) throw osError;

        // 2. Update equipment status based on OS status (only for equipment not linked to active rental)
        if (os.equipment_id && !os.rental_invoice_id) {
            if (os.status === 'Concluída' || os.status === 'Encerrada com pendências' || os.status === 'Cancelada') {
                await supabase
                    .from('equipments')
                    .update({ status: 'Disponível' })
                    .eq('id', os.equipment_id);
            } else {
                await supabase
                    .from('equipments')
                    .update({ status: 'Em Manutenção' })
                    .eq('id', os.equipment_id);
            }
        }

        // 3. Replace parts: update stock, delete old service_order_parts, insert new
        if (parts && Array.isArray(parts)) {
            // Apply stock updates and audit logs
            for (const partId of affectedPartIds) {
                const oldQty = oldQuantities[partId] || 0;
                const newQty = newQuantities[partId] || 0;
                const diff = newQty - oldQty;

                if (diff !== 0) {
                    const dbPart = stockQuantities[partId];
                    const currentStock = dbPart ? (Number(dbPart.quantity) || 0) : 0;
                    const newStock = currentStock - diff;
                    
                    await supabase
                        .from('parts')
                        .update({ quantity: newStock })
                        .eq('id', partId);

                    const movementType = diff > 0 ? 'SAIDA' : 'ENTRADA';
                    const movementQty = Math.abs(diff);

                    const osId = String(id);
                    await recordStockMovement(supabase, {
                        part_id: partId,
                        movement_type: movementType,
                        quantity: movementQty,
                        previous_stock: currentStock,
                        new_stock: newStock,
                        reference_type: 'SERVICE_ORDER',
                        reference_id: osId,
                        reference_label: `OS #${osData.os_number || osId.slice(0, 8)}`,
                        notes: diff > 0
                            ? `Consumo adicional de peça na OS #${osData.os_number || osId.slice(0, 8)}.`
                            : `Estorno/devolução de peça na OS #${osData.os_number || osId.slice(0, 8)}.`,
                        created_by: req.user?.id || null,
                    });
                }
            }

            // Replace service order parts records
            await supabase
                .from('service_order_parts')
                .delete()
                .eq('service_order_id', id);

            if (parts.length > 0) {
                const partsToInsert = parts.map((p: any) => ({
                    service_order_id: id,
                    part_id: p.part_id,
                    quantity_used: p.quantity_used,
                    unit_value_at_use: p.unit_value_at_use,
                    was_used: p.was_used !== undefined ? p.was_used : true
                }));

                const { error: partsError } = await supabase
                    .from('service_order_parts')
                    .insert(partsToInsert);

                if (partsError) throw partsError;
            }
        }

        // 4. Replace labor: delete old, insert new
        if (labor && Array.isArray(labor)) {
            await supabase
                .from('service_order_labor')
                .delete()
                .eq('service_order_id', id);

            if (labor.length > 0) {
                const laborToInsert = labor.map((l: any) => ({
                    service_order_id: id,
                    technician_name: l.technician_name,
                    labor_date: l.labor_date || null,
                    start_time: l.start_time || null,
                    end_time: l.end_time || null,
                    labor_type: l.labor_type || 'T'
                }));

                const { error: laborError } = await supabase
                    .from('service_order_labor')
                    .insert(laborToInsert);

                if (laborError) throw laborError;
            }
        }

        // Return full data
        const { data: fullOS, error: fetchError } = await supabase
            .from('service_orders')
            .select(SERVICE_ORDER_SELECT)
            .eq('id', id)
            .single();

        if (fetchError) throw fetchError;
        return res.json(fullOS);
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
};

export const updateServiceOrderStatus = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const supabase = getSupabaseUserClient(req.token!);
        
        const { data: os, error: osError } = await supabase
            .from('service_orders')
            .update({ status })
            .eq('id', id)
            .select()
            .single();

        if (osError) throw osError;

        // If OS is concluded, closed with pendencies or cancelled, update equipment status back to 'Disponível'
        if ((status === 'Concluída' || status === 'Encerrada com pendências' || status === 'Cancelada') && os.equipment_id) {
            await supabase
                .from('equipments')
                .update({ status: 'Disponível' })
                .eq('id', os.equipment_id);
        } else if (os.equipment_id) {
            await supabase
                .from('equipments')
                .update({ status: 'Em Manutenção' })
                .eq('id', os.equipment_id);
        }

        return res.json(os);
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
};

export const deleteServiceOrder = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { error } = await supabase
      .from('service_orders')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
