-- Migration: Alter rental_invoice_equipments_deal_contract_id_fkey to ON DELETE SET NULL
-- Fixes issue where deleting or regenerating a CRM contract deleted the rental equipment periods

ALTER TABLE public.rental_invoice_equipments 
  DROP CONSTRAINT IF EXISTS rental_invoice_equipments_deal_contract_id_fkey,
  ADD CONSTRAINT rental_invoice_equipments_deal_contract_id_fkey 
    FOREIGN KEY (deal_contract_id) 
    REFERENCES public.crm_deal_contracts(id) 
    ON DELETE SET NULL;
