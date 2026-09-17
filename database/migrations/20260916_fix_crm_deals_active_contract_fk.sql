-- Migration: Alter crm_deals_active_contract_id_fkey to ON DELETE SET NULL
-- Fixes foreign key constraint violation when deleting contracts/rentals

ALTER TABLE public.crm_deals 
  DROP CONSTRAINT IF EXISTS crm_deals_active_contract_id_fkey,
  ADD CONSTRAINT crm_deals_active_contract_id_fkey 
    FOREIGN KEY (active_contract_id) 
    REFERENCES public.crm_deal_contracts(id) 
    ON DELETE SET NULL;
