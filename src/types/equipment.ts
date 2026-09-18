export interface Equipment {
  id: string;
  asset_number: string;
  name: string;
  type: string;
  model: string;
  serial_number: string;
  height: number;
  status: 'Disponível' | 'Locado' | 'Em Manutenção' | 'Inativo';
  manufacture_year: number;
  value: number;
  unit: string;
  photo_url?: string;
  hour_meter?: number | null;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface EquipmentDocument {
  id: string;
  equipment_id: string;
  document_name: string;
  file_url: string;
  file_name?: string | null;
  file_size?: number | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
  created_by_profile?: {
    id: string;
    full_name: string;
  } | null;
  updated_by_profile?: {
    id: string;
    full_name: string;
  } | null;
}

export interface EquipmentHourMeterLog {
  id: string;
  equipment_id: string;
  hour_meter: number;
  previous_hour_meter?: number | null;
  source_type: 'service_order' | 'rental_dispatch' | 'rental_return' | 'manual';
  reference_id?: string | null;
  reference_number?: string | null;
  notes?: string | null;
  created_by?: string | null;
  created_at: string;
  created_by_profile?: {
    id: string;
    full_name: string;
  } | null;
}

