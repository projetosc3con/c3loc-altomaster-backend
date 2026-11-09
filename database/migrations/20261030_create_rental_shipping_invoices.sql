-- Migração: Criação da tabela de Notas Fiscais de Remessa e Retorno (NF-e Modelo 55)
-- Data: 2026-10-30

CREATE TABLE IF NOT EXISTS public.rental_shipping_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_invoice_id UUID REFERENCES public.rental_invoices(id) ON DELETE CASCADE,
  deal_contract_id UUID REFERENCES public.crm_deal_contracts(id) ON DELETE SET NULL,
  
  -- Direção e Origem
  direction TEXT NOT NULL CHECK (direction IN ('SAIDA', 'RETORNO')),
  issuer_type TEXT NOT NULL CHECK (issuer_type IN ('SISTEMA_NOTAAS', 'CLIENTE_EXTERNO')),
  
  -- Identificadores da NF-e
  nfe_number INTEGER,
  serie INTEGER DEFAULT 1,
  access_key VARCHAR(44),
  protocol VARCHAR(50),
  
  -- Status da Notaas / SEFAZ
  notaas_invoice_id UUID,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'issued', 'error', 'cancelled')),
  status_code INTEGER,
  status_message TEXT,
  
  -- Valores e Parâmetros Fiscais
  natureza_operacao TEXT NOT NULL,
  total_value NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
  cfop VARCHAR(10) NOT NULL,
  
  -- Arquivos e Links
  danfe_pdf_url TEXT,
  xml_url TEXT,
  
  -- Metadados de Auditoria
  created_by UUID REFERENCES public.users_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Índices de consulta rápida
CREATE INDEX IF NOT EXISTS idx_rental_shipping_rental_id ON public.rental_shipping_invoices(rental_invoice_id);
CREATE INDEX IF NOT EXISTS idx_rental_shipping_contract_id ON public.rental_shipping_invoices(deal_contract_id);
CREATE INDEX IF NOT EXISTS idx_rental_shipping_access_key ON public.rental_shipping_invoices(access_key);

-- RLS
ALTER TABLE public.rental_shipping_invoices ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'rental_shipping_invoices' AND policyname = 'Allow all authenticated users on rental_shipping_invoices'
  ) THEN
    CREATE POLICY "Allow all authenticated users on rental_shipping_invoices"
      ON public.rental_shipping_invoices
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

