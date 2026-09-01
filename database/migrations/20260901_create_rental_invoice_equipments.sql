-- ==============================================================================
-- Migração: Criação da tabela rental_invoice_equipments
-- Objetivo: Permitir múltiplos equipamentos por locação e contrato de CRM
-- Data: 2026-09-01
-- ==============================================================================

-- 1. Criação da tabela
CREATE TABLE IF NOT EXISTS public.rental_invoice_equipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rental_invoice_id UUID REFERENCES public.rental_invoices(id) ON DELETE CASCADE,
    deal_contract_id UUID REFERENCES public.crm_deal_contracts(id) ON DELETE CASCADE,
    equipment_id UUID REFERENCES public.equipments(id) ON DELETE RESTRICT,
    equipment_name TEXT,
    equipment_type TEXT,
    equipment_size TEXT,
    asset_number TEXT,
    billing_period_start DATE NOT NULL,
    billing_period_end DATE NOT NULL,
    return_date DATE,
    cost_rental NUMERIC DEFAULT 0,
    cost_insurance NUMERIC DEFAULT 0,
    cost_freight NUMERIC DEFAULT 0,
    cost_rcd NUMERIC DEFAULT 0,
    cost_third_party NUMERIC DEFAULT 0,
    cost_training NUMERIC DEFAULT 0,
    total_value NUMERIC DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 2. Criação de índices
CREATE INDEX IF NOT EXISTS idx_rental_invoice_equipments_invoice ON public.rental_invoice_equipments(rental_invoice_id);
CREATE INDEX IF NOT EXISTS idx_rental_invoice_equipments_contract ON public.rental_invoice_equipments(deal_contract_id);
CREATE INDEX IF NOT EXISTS idx_rental_invoice_equipments_equipment ON public.rental_invoice_equipments(equipment_id);

-- 3. Habilitação de RLS e Policies
ALTER TABLE public.rental_invoice_equipments ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'rental_invoice_equipments' 
        AND policyname = 'Permitir acesso completo a usuarios autenticados'
    ) THEN
        CREATE POLICY "Permitir acesso completo a usuarios autenticados" 
        ON public.rental_invoice_equipments
        FOR ALL TO authenticated 
        USING (true) 
        WITH CHECK (true);
    END IF;
END $$;

-- 4. Migração retroativa de dados legados existentes em rental_invoices
INSERT INTO public.rental_invoice_equipments (
    rental_invoice_id,
    equipment_id,
    equipment_name,
    equipment_type,
    equipment_size,
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
)
SELECT
    id,
    equipment_id,
    equipment_name,
    equipment_type,
    equipment_size,
    asset_number,
    COALESCE(billing_period_start, CURRENT_DATE),
    COALESCE(billing_period_end, CURRENT_DATE + INTERVAL '30 days'),
    return_date,
    COALESCE(cost_rental, 0),
    COALESCE(cost_insurance, 0),
    COALESCE(cost_freight, 0),
    COALESCE(cost_rcd, 0),
    COALESCE(cost_third_party, 0),
    COALESCE(cost_training, 0),
    COALESCE(total_value, 0)
FROM public.rental_invoices
WHERE equipment_id IS NOT NULL
  AND id NOT IN (
      SELECT rental_invoice_id 
      FROM public.rental_invoice_equipments 
      WHERE rental_invoice_id IS NOT NULL
  );
