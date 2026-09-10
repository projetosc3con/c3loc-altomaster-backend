-- ==============================================================================
-- Migração: Adicionar coluna return_checklist_urls na tabela rental_invoices
-- Objetivo: Armazenar URLs dos arquivos PDF de checklist de retorno gerados
-- Data: 2026-09-10
-- ==============================================================================

ALTER TABLE public.rental_invoices 
ADD COLUMN IF NOT EXISTS return_checklist_urls TEXT[] DEFAULT '{}'::TEXT[];
