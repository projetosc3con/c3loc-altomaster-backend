export type HourMeterSourceType = 'service_order' | 'rental_dispatch' | 'rental_return' | 'manual';

export interface RecordHourMeterParams {
  equipment_id: string;
  new_hour_meter: number;
  source_type: HourMeterSourceType;
  reference_id?: string | null;
  reference_number?: string | null;
  notes?: string | null;
  created_by?: string | null;
}

/**
 * Atualiza o horímetro do equipamento e grava o log histórico de auditoria.
 */
export const recordHourMeterUpdate = async (
  supabase: any,
  params: RecordHourMeterParams
): Promise<{ updated: boolean; previous_hour_meter?: number | null; new_hour_meter: number }> => {
  const { equipment_id, new_hour_meter, source_type, reference_id, reference_number, notes, created_by } = params;
  if (!equipment_id || new_hour_meter == null || isNaN(Number(new_hour_meter))) {
    return { updated: false, new_hour_meter: 0 };
  }

  const parsedNew = Number(new_hour_meter);

  // 1. Obter horímetro atual do equipamento
  const { data: equip, error: eqErr } = await supabase
    .from('equipments')
    .select('id, hour_meter')
    .eq('id', equipment_id)
    .single();

  if (eqErr || !equip) {
    console.error(`[hourMeterService] Equipamento ${equipment_id} não encontrado:`, eqErr);
    return { updated: false, new_hour_meter: parsedNew };
  }

  const currentHourMeter = equip.hour_meter != null ? Number(equip.hour_meter) : null;

  // Se o valor for idêntico e não for manual, não precisa atualizar
  if (currentHourMeter !== null && Math.abs(currentHourMeter - parsedNew) < 0.001 && source_type !== 'manual') {
    return { updated: false, previous_hour_meter: currentHourMeter, new_hour_meter: parsedNew };
  }

  // 2. Atualizar o horímetro na tabela equipments
  const { error: updateErr } = await supabase
    .from('equipments')
    .update({
      hour_meter: parsedNew,
      updated_at: new Date().toISOString(),
    })
    .eq('id', equipment_id);

  if (updateErr) {
    console.error(`[hourMeterService] Erro ao atualizar horímetro do equipamento ${equipment_id}:`, updateErr);
    throw updateErr;
  }

  // 3. Registrar o log na tabela equipment_hour_meter_logs
  const { error: logErr } = await supabase
    .from('equipment_hour_meter_logs')
    .insert({
      equipment_id,
      hour_meter: parsedNew,
      previous_hour_meter: currentHourMeter,
      source_type,
      reference_id: reference_id || null,
      reference_number: reference_number || null,
      notes: notes || null,
      created_by: created_by || null,
    });

  if (logErr) {
    console.error(`[hourMeterService] Erro ao gravar log de horímetro para equipamento ${equipment_id}:`, logErr);
  }

  return { updated: true, previous_hour_meter: currentHourMeter, new_hour_meter: parsedNew };
};
