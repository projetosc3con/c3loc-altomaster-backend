-- ============================================================================
-- Migration: Manutenção Preventiva (Elétrica / Diesel) + Lista de Peças do Equipamento
-- Projeto Supabase: qnpebqoxxxjcdorlhame
-- Data: 2026-11-26
-- ============================================================================

-- 1. Tabela de Lista de Peças de Referência por Equipamento (sem baixa de estoque)
CREATE TABLE IF NOT EXISTS public.equipment_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id UUID NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  part_id UUID NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
  default_quantity NUMERIC(12, 2) NOT NULL DEFAULT 1,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT equipment_parts_unique_eq_part UNIQUE (equipment_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_equipment_parts_equipment_id ON public.equipment_parts(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_parts_part_id ON public.equipment_parts(part_id);

ALTER TABLE public.equipment_parts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'equipment_parts' AND policyname = 'Authenticated users can read equipment_parts'
  ) THEN
    CREATE POLICY "Authenticated users can read equipment_parts"
      ON public.equipment_parts FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'equipment_parts' AND policyname = 'Authenticated users can insert equipment_parts'
  ) THEN
    CREATE POLICY "Authenticated users can insert equipment_parts"
      ON public.equipment_parts FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'equipment_parts' AND policyname = 'Authenticated users can update equipment_parts'
  ) THEN
    CREATE POLICY "Authenticated users can update equipment_parts"
      ON public.equipment_parts FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'equipment_parts' AND policyname = 'Authenticated users can delete equipment_parts'
  ) THEN
    CREATE POLICY "Authenticated users can delete equipment_parts"
      ON public.equipment_parts FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;

-- 2. Campos de Manutenção Preventiva na tabela service_orders
ALTER TABLE public.service_orders
  ADD COLUMN IF NOT EXISTS maintenance_category TEXT NOT NULL DEFAULT 'OS',
  ADD COLUMN IF NOT EXISTS preventive_type TEXT,
  ADD COLUMN IF NOT EXISTS contract_number TEXT,
  ADD COLUMN IF NOT EXISTS preventive_checklist JSONB;

CREATE INDEX IF NOT EXISTS idx_service_orders_maintenance_category
  ON public.service_orders(maintenance_category);

-- 3. Campos adicionais de deslocamento por linha na tabela service_order_labor
ALTER TABLE public.service_order_labor
  ADD COLUMN IF NOT EXISTS vehicle_plate TEXT,
  ADD COLUMN IF NOT EXISTS km_start NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS km_end NUMERIC(12, 2);
