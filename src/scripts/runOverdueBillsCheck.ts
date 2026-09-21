import dotenv from 'dotenv';
dotenv.config();

import { updateOverdueBills } from '../services/billOverdueService';

async function main() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('  EXECUTANDO CONFERÊNCIA MANUAL DE CONTAS VENCIDAS');
  console.log('════════════════════════════════════════════════════════════');
  
  try {
    const result = await updateOverdueBills();
    console.log('\n--- Resultado da Operação ---');
    console.log(`Data de Referência (Hoje): ${result.today}`);
    console.log(`Total de Contas Atualizadas: ${result.totalUpdated}`);
    console.log(`Mensagem: ${result.message}`);

    if (result.updatedBills.length > 0) {
      console.log('\nContas que tiveram o status alterado para "Atrasado":');
      console.table(
        result.updatedBills.map((b) => ({
          ID: b.id,
          Vencimento: b.due_date,
          'Status Anterior': b.previous_status,
          Contraparte: b.counterparty_name || 'N/A',
          Descrição: b.description.length > 40 ? b.description.substring(0, 37) + '...' : b.description,
        }))
      );
    }

    console.log('\n✓ Processo finalizado com sucesso.');
    process.exit(0);
  } catch (error: any) {
    console.error('\n✗ Falha ao executar conferência de contas vencidas:', error);
    process.exit(1);
  }
}

main();
