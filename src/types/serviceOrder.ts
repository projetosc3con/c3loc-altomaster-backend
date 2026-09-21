export interface RcdPartItem {
  part_id: string;
  internal_code: string;
  description: string;
  quantity: number;
  unit_value: number;
  subtotal: number;
}

export interface RcdServiceItem {
  id?: string;
  type: 'deslocamento' | 'mao_de_obra' | 'outro';
  description: string;
  km?: number;
  hours?: number;
  quantity: number;
  unit_value: number;
  subtotal: number;
  notes?: string;
}

export interface RcdInstallment {
  installment_number: number;
  due_date: string;
  gross_value: number;
}

export interface ServiceOrderRcd {
  id: string;
  service_order_id: string;
  rcd_number?: string;
  issue_date: string;
  validity_date?: string;
  payment_terms?: string;
  notes?: string;
  origin_description?: string;

  client_id?: string | null;
  client_name?: string;
  client_cnpj?: string;
  client_address?: string;
  client_ie?: string;
  client_contact?: string;
  client_phone?: string;

  equipment_id?: string | null;
  equipment_name?: string;
  equipment_asset_number?: string;
  equipment_model?: string;
  problem_description?: string;

  parts: RcdPartItem[];
  services: RcdServiceItem[];

  total_parts: number;
  total_services: number;
  total_value: number;

  payment_method?: string;
  payment_type?: 'a_vista' | 'parcelado';
  installments_count?: number;
  installments_data?: RcdInstallment[];

  bill_ids?: string[];
  bill_group_id?: string;
  billed_at?: string;
  invoice_number?: string;

  signed_document_url?: string;
  signed_at?: string;
  signed_by_name?: string;

  status: 'Rascunho' | 'Pendente' | 'Faturado' | 'Aprovado' | 'Cancelado';
  created_at: string;
  updated_at: string;
  created_by?: string | null;
}
