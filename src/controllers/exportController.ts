import { Response } from 'express';
import * as XLSX from 'xlsx';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';

const EXPORT_BUCKET = 'exports';
// Signed URL expires after 5 minutes
const SIGNED_URL_EXPIRES_IN = 300;

export const exportClientsToXlsx = async (req: AuthRequest, res: Response) => {
  try {
    // 1. Fetch all clients using the authenticated user's token (respects RLS)
    const supabase = getSupabaseUserClient(req.token!);
    const { data: clients, error: fetchError } = await supabase
      .from('clients')
      .select('*')
      .order('company_name', { ascending: true });

    if (fetchError) throw fetchError;
    if (!clients || clients.length === 0) {
      return res.status(404).json({ error: 'Nenhum cliente encontrado para exportar.' });
    }

    // 2. Map data to a readable format with Portuguese column headers
    const exportData = clients.map((client) => ({
      'ID': client.id,
      'Empresa / Razão Social': client.company_name,
      'CNPJ': client.cnpj,
      'Inscrição Estadual': client.state_subscription || 'ISENTO',
      'Contato': client.contact_name || '',
      'E-mail': client.email || '',
      'Telefone': client.phone || '',
      'CEP': client.address_zip || '',
      'Endereço': client.address_street || '',
      'Número': client.address_number || '',
      'Complemento': client.address_complement || '',
      'Cidade': client.address_city || '',
      'Estado (UF)': client.address_state || '',
      'Status': client.active ? 'Ativo' : 'Inativo',
      'Criado em': client.created_at
        ? new Date(client.created_at).toLocaleDateString('pt-BR')
        : '',
    }));

    // 3. Build the XLSX workbook
    const ws = XLSX.utils.json_to_sheet(exportData);

    // Set column widths for readability
    ws['!cols'] = [
      { wch: 38 }, // ID
      { wch: 35 }, // Empresa
      { wch: 20 }, // CNPJ
      { wch: 18 }, // IE
      { wch: 25 }, // Contato
      { wch: 30 }, // E-mail
      { wch: 16 }, // Telefone
      { wch: 12 }, // CEP
      { wch: 35 }, // Endereço
      { wch: 10 }, // Número
      { wch: 20 }, // Complemento
      { wch: 22 }, // Cidade
      { wch: 6  }, // UF
      { wch: 10 }, // Status
      { wch: 14 }, // Criado em
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Clientes');

    // 4. Write workbook to a Buffer
    const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // 5. Upload to Supabase Storage using admin client (service role bypasses RLS for upload)
    const userEmail = (req.user?.email ?? 'unknown').replace(/[@.]/g, '_');
    const fileName = `clientes_${new Date().toISOString().split('T')[0]}_${userEmail}_${Date.now()}.xlsx`;
    const storagePath = `clients/${fileName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(EXPORT_BUCKET)
      .upload(storagePath, xlsxBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: false,
      });

    if (uploadError) throw uploadError;

    // 6. Generate a signed URL valid for SIGNED_URL_EXPIRES_IN seconds
    const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin.storage
      .from(EXPORT_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRES_IN);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      throw signedUrlError ?? new Error('Falha ao gerar URL de download.');
    }

    return res.status(200).json({
      downloadUrl: signedUrlData.signedUrl,
      fileName,
      expiresIn: SIGNED_URL_EXPIRES_IN,
      totalRecords: clients.length,
    });
  } catch (error: any) {
    console.error('[exportClientsToXlsx]', error);
    return res.status(500).json({ error: error.message || 'Erro interno ao gerar exportação.' });
  }
};

export const exportRentalsToXlsx = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // Build query with optional filters (same params as list endpoint)
    let query = supabase
      .from('rental_invoices')
      .select('*');

    const search = (req.query.search as string) || '';
    const billingStatus = (req.query.billing_status as string) || '';
    const reconciliationStatus = (req.query.reconciliation_status as string) || '';
    const dateFrom = (req.query.date_from as string) || '';
    const dateTo = (req.query.date_to as string) || '';
    const valueMin = parseFloat(req.query.value_min as string) || 0;
    const valueMax = parseFloat(req.query.value_max as string) || 0;

    if (search) {
      query = query.or(
        `client_name.ilike.%${search}%,equipment_name.ilike.%${search}%,asset_number.ilike.%${search}%,invoice_number.ilike.%${search}%`
      );
    }
    if (billingStatus) query = query.eq('billing_status', billingStatus);
    if (reconciliationStatus) query = query.eq('reconciliation_status', reconciliationStatus);
    if (dateFrom) query = query.gte('billing_period_start', dateFrom);
    if (dateTo) query = query.lte('billing_period_start', dateTo);
    if (valueMin > 0) query = query.gte('total_value', valueMin);
    if (valueMax > 0) query = query.lte('total_value', valueMax);

    // Sorting
    const sortBy = (req.query.sort_by as string) || 'billing_period_end';
    const sortOrder = (req.query.sort_order as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc';
    const allowedSortFields: Record<string, string> = {
      billing_period_end: 'billing_period_end',
      billing_period_start: 'billing_period_start',
      client_name: 'client_name',
      equipment_name: 'equipment_name',
      total_value: 'total_value',
      billing_status: 'billing_status',
      created_at: 'created_at',
      invoice_number: 'invoice_number'
    };
    const orderColumn = allowedSortFields[sortBy] || 'billing_period_end';

    const { data: rentals, error: fetchError } = await query
      .order(orderColumn, { ascending: sortOrder === 'asc', nullsFirst: false })
      .order('created_at', { ascending: false });

    if (fetchError) throw fetchError;
    if (!rentals || rentals.length === 0) {
      return res.status(404).json({ error: 'Nenhuma locação encontrada para exportar.' });
    }

    const exportData = rentals.map((r) => ({
      'Nº Fatura': r.invoice_number || '',
      'Cliente': r.client_name || '',
      'CNPJ': r.cnpj || '',
      'Equipamento': r.equipment_name || '',
      'Tipo Equipamento': r.equipment_type || '',
      'Patrimônio': r.asset_number || '',
      'Obra': r.work_site || '',
      'Início Período': r.billing_period_start
        ? new Date(r.billing_period_start).toLocaleDateString('pt-BR')
        : '',
      'Fim Período': r.billing_period_end
        ? new Date(r.billing_period_end).toLocaleDateString('pt-BR')
        : '',
      'Status Faturamento': r.billing_status || '',
      'Data Devolução': r.return_date
        ? new Date(r.return_date).toLocaleDateString('pt-BR')
        : '',
      'Locação (R$)': Number(r.cost_rental || 0).toFixed(2),
      'Seguro (R$)': Number(r.cost_insurance || 0).toFixed(2),
      'Frete (R$)': Number(r.cost_freight || 0).toFixed(2),
      'RCD (R$)': Number(r.cost_rcd || 0).toFixed(2),
      'Terceiros (R$)': Number(r.cost_third_party || 0).toFixed(2),
      'Treinamento (R$)': Number(r.cost_training || 0).toFixed(2),
      'Valor Total (R$)': Number(r.total_value || 0).toFixed(2),
      'Vencimento': r.due_date
        ? new Date(r.due_date).toLocaleDateString('pt-BR')
        : '',
      'Forma Pagamento': r.payment_method || '',
      'Status Conciliação': r.reconciliation_status || '',
      'Observações': r.notes || '',
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    ws['!cols'] = [
      { wch: 14 }, // Nº Fatura
      { wch: 30 }, // Cliente
      { wch: 20 }, // CNPJ
      { wch: 30 }, // Equipamento
      { wch: 18 }, // Tipo
      { wch: 14 }, // Patrimônio
      { wch: 25 }, // Obra
      { wch: 14 }, // Início
      { wch: 14 }, // Fim
      { wch: 18 }, // Status Fat
      { wch: 14 }, // Devolução
      { wch: 14 }, // Locação
      { wch: 14 }, // Seguro
      { wch: 14 }, // Frete
      { wch: 14 }, // RCD
      { wch: 14 }, // Terceiros
      { wch: 14 }, // Treinamento
      { wch: 16 }, // Valor Total
      { wch: 14 }, // Vencimento
      { wch: 18 }, // Forma Pagamento
      { wch: 18 }, // Status Conciliação
      { wch: 30 }, // Observações
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Locações');

    const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const userEmail = (req.user?.email ?? 'unknown').replace(/[@.]/g, '_');
    const fileName = `locacoes_${new Date().toISOString().split('T')[0]}_${userEmail}_${Date.now()}.xlsx`;
    const storagePath = `rentals/${fileName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(EXPORT_BUCKET)
      .upload(storagePath, xlsxBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin.storage
      .from(EXPORT_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRES_IN);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      throw signedUrlError ?? new Error('Falha ao gerar URL de download.');
    }

    return res.status(200).json({
      downloadUrl: signedUrlData.signedUrl,
      fileName,
      expiresIn: SIGNED_URL_EXPIRES_IN,
      totalRecords: rentals.length,
    });
  } catch (error: any) {
    console.error('[exportRentalsToXlsx]', error);
    return res.status(500).json({ error: error.message || 'Erro interno ao gerar exportação.' });
  }
};
