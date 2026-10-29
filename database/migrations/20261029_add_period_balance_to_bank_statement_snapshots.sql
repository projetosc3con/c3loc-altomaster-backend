-- Adiciona coluna de saldo do período (saldoAnterior / saldoAtual - indicadorTipoLancamento 'SA')
-- na tabela bank_statement_snapshots
ALTER TABLE bank_statement_snapshots 
ADD COLUMN IF NOT EXISTS period_balance NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS saldo_anterior NUMERIC DEFAULT 0;

