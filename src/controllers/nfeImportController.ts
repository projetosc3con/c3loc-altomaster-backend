import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';
import { parseNfeXml, ParsedNfeData, normalizeUnit } from '../services/nfeParserService';
import { parseDanfePdf } from '../services/danfeParserService';
import { recordStockMovement } from '../services/stockMovementService';
import { getCategoryPrefix } from './partController';

export const parseXml = async (req: AuthRequest, res: Response) => {
  try {
    const { xml, pdf_base64 } = req.body;

    let parsedData: ParsedNfeData;

    if (pdf_base64 && typeof pdf_base64 === 'string') {
      const cleanBase64 = pdf_base64.replace(/^data:application\/pdf;base64,/, '');
      const pdfBuffer = Buffer.from(cleanBase64, 'base64');
      parsedData = await parseDanfePdf(pdfBuffer);
    } else if (xml && typeof xml === 'string') {
      parsedData = parseNfeXml(xml);
    } else {
      return res.status(400).json({ error: 'Nenhum arquivo XML ou PDF fornecido ou formato inválido.' });
    }

    // Check if access_key is already in nfe_imports
    const supabase = getSupabaseUserClient(req.token!);
    const { data: existingImport } = await supabase
      .from('nfe_imports')
      .select('id, invoice_number, created_at')
      .eq('access_key', parsedData.access_key)
      .maybeSingle();

    return res.json({
      ...parsedData,
      already_imported: Boolean(existingImport),
      existing_import: existingImport || null,
    });
  } catch (error: any) {
    console.error('[parseXml] Erro ao analisar documento da NF-e:', error);
    return res.status(400).json({ error: error.message || 'Erro ao processar o arquivo da NF-e.' });
  }
};

export const processImport = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const {
      xml,
      parsed_data,
      items_config,
      payment_config,
    } = req.body;

    if (!parsed_data || !parsed_data.access_key) {
      return res.status(400).json({ error: 'Dados da NF-e ausentes ou inválidos.' });
    }

    const accessKey = parsed_data.access_key;
    const invoiceNumber = String(parsed_data.invoice_number);

    // Check if already imported
    const { data: existingImport } = await supabase
      .from('nfe_imports')
      .select('id')
      .eq('access_key', accessKey)
      .maybeSingle();

    if (existingImport) {
      return res.status(400).json({
        error: `A NF-e nº ${invoiceNumber} (Chave: ${accessKey}) já foi importada anteriormente no sistema.`
      });
    }

    let equipmentsCreated = 0;
    let partsCreated = 0;
    let partsUpdated = 0;
    let billsCreated = 0;

    const items = parsed_data.items || [];
    const itemsConfigMap = new Map();
    if (Array.isArray(items_config)) {
      items_config.forEach((ic: any) => {
        itemsConfigMap.set(ic.item_index, ic);
      });
    } else if (req.body.destinations && typeof req.body.destinations === 'object') {
      Object.entries(req.body.destinations).forEach(([idxStr, destConfig]: [string, any]) => {
        itemsConfigMap.set(Number(idxStr), { item_index: Number(idxStr), ...destConfig });
      });
    }

    // 1. Process Items
    for (const item of items) {
      const config = itemsConfigMap.get(item.item_index) || { destination: item.suggested_destination };
      const destination = config.destination || item.suggested_destination;

      if (destination === 'ignore') {
        continue;
      }

      // DESTINATION: EQUIPMENT (Ativo Imobilizado)
      if (destination === 'equipment') {
        // Generate asset number or use custom
        let assetNumber = config.custom_asset_number;
        if (!assetNumber) {
          // Find max asset number or count
          const { count } = await supabase
            .from('equipments')
            .select('*', { count: 'exact', head: true });
          const nextIndex = (count || 0) + 1;
          assetNumber = `AST-${String(nextIndex).padStart(4, '0')}`;
        }

        const equipData = {
          asset_number: assetNumber,
          name: config.custom_name || item.description,
          type: config.custom_type || 'Equipamento',
          model: config.custom_model || item.extracted_model || 'N/A',
          serial_number: config.custom_serial_number || item.extracted_serial_number || 'N/A',
          height: config.custom_height ? Number(config.custom_height) : null,
          status: 'Disponível',
          manufacture_year: new Date(parsed_data.issue_date).getFullYear() || new Date().getFullYear(),
          value: config.custom_unit_value != null ? Number(config.custom_unit_value) : item.unit_value || item.total_value,
          unit: config.custom_unit || item.unit || 'UN',
          invoice_number: invoiceNumber,
          nfe_access_key: accessKey,
          supplier_name: parsed_data.issuer?.name || '',
          supplier_cnpj: parsed_data.issuer?.cnpj || '',
          product_code: item.product_code || '',
          ncm: item.ncm || '',
          cst: item.cst_icms || '',
          cfop: item.cfop || '',
          tax_details: item.tax_details || {},
          purchase_date: parsed_data.issue_date ? parsed_data.issue_date.split('T')[0] : new Date().toISOString().split('T')[0],
          notes: `Importado via NF-e nº ${invoiceNumber} (Emitente: ${parsed_data.issuer?.name || 'N/A'}).`,
          created_by: req.user?.id || null,
        };

        const { error: eqErr } = await supabase.from('equipments').insert(equipData);
        if (eqErr) {
          console.error('[processImport] Erro ao inserir equipamento:', eqErr);
          throw new Error(`Erro ao cadastrar equipamento "${equipData.name}": ${eqErr.message}`);
        }
        equipmentsCreated++;
      }

      // DESTINATION: PARTS / MATERIALS (Peça, Consumo, EPI, Outros)
      if (destination.startsWith('part_')) {
        let category: 'Peça' | 'Consumo' | 'EPI' | 'Outros' = 'Peça';
        if (destination === 'part_consumo') category = 'Consumo';
        else if (destination === 'part_epi') category = 'EPI';
        else if (destination === 'part_outros') category = 'Outros';

        const itemQty = config.custom_quantity != null ? Number(config.custom_quantity) : Number(item.quantity || 1);
        const itemUnitVal = config.custom_unit_value != null ? Number(config.custom_unit_value) : Number(item.unit_value || 0);
        const itemUnit = normalizeUnit(config.custom_unit || item.unit || 'UN');

        // Check if existing material by product_code (part_number) or exact description
        let existingPart: any = null;
        if (item.product_code) {
          const { data: foundByPn } = await supabase
            .from('parts')
            .select('*')
            .eq('part_number', item.product_code)
            .maybeSingle();
          if (foundByPn) existingPart = foundByPn;
        }

        if (!existingPart && item.description) {
          const { data: foundByDesc } = await supabase
            .from('parts')
            .select('*')
            .ilike('description', item.description.trim())
            .maybeSingle();
          if (foundByDesc) existingPart = foundByDesc;
        }

        if (existingPart) {
          // Increment stock and update unit value & fiscal ref
          const previousStock = Number(existingPart.quantity) || 0;
          const updatedQty = previousStock + itemQty;
          const { error: partUpdErr } = await supabase
            .from('parts')
            .update({
              quantity: updatedQty,
              unit_value: itemUnitVal,
              invoice_number: invoiceNumber,
              nfe_access_key: accessKey,
              supplier_name: parsed_data.issuer?.name || existingPart.supplier_name,
              supplier_cnpj: parsed_data.issuer?.cnpj || existingPart.supplier_cnpj,
              ncm: item.ncm || existingPart.ncm,
              cfop: item.cfop || existingPart.cfop,
              unit: itemUnit || existingPart.unit,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingPart.id);

          if (partUpdErr) {
            console.error('[processImport] Erro ao atualizar estoque de peça:', partUpdErr);
            throw new Error(`Erro ao atualizar estoque da peça "${existingPart.description}": ${partUpdErr.message}`);
          }

          // Auditoria de movimentação
          await recordStockMovement(supabase, {
            part_id: existingPart.id,
            movement_type: 'ENTRADA',
            quantity: itemQty,
            unit_value: itemUnitVal,
            previous_stock: previousStock,
            new_stock: updatedQty,
            reference_type: 'NFE_IMPORT',
            reference_id: accessKey,
            reference_label: `NF-e ${invoiceNumber}`,
            notes: `Entrada de estoque via NF-e nº ${invoiceNumber} (${parsed_data.issuer?.name || 'Fornecedor'}).`,
            created_by: req.user?.id || null,
          });

          partsUpdated++;
        } else {
          // Create new material: generate next sequential code for the category
          const prefix = getCategoryPrefix(category);
          const { data: existingCodes } = await supabase
            .from('parts')
            .select('internal_code')
            .like('internal_code', `${prefix}%`);

          let maxSeq = 0;
          for (const c of (existingCodes || [])) {
            if (!c.internal_code) continue;
            const codeTrim = c.internal_code.trim();
            if (codeTrim.toUpperCase().startsWith(prefix)) {
              const num = parseInt(codeTrim.slice(prefix.length), 10);
              if (!isNaN(num) && num > maxSeq) maxSeq = num;
            }
          }
          const nextSeq = maxSeq + 1;
          const internalCode = `${prefix}${String(nextSeq).padStart(4, '0')}`;

          const newPartData = {
            internal_code: internalCode,
            description: config.custom_name || item.description,
            category: category,
            unit: itemUnit,
            part_number: item.product_code || null,
            quantity: itemQty,
            unit_value: itemUnitVal,
            ncm: item.ncm || null,
            cfop: item.cfop || null,
            invoice_number: invoiceNumber,
            nfe_access_key: accessKey,
            supplier_name: parsed_data.issuer?.name || null,
            supplier_cnpj: parsed_data.issuer?.cnpj || null,
            notes: `Cadastrado via importação da NF-e nº ${invoiceNumber} (${parsed_data.issuer?.name || 'Fornecedor'}).`,
            created_by: req.user?.id || null,
          };

          const { data: insertedPart, error: partInsErr } = await supabase
            .from('parts')
            .insert(newPartData)
            .select()
            .single();

          if (partInsErr) {
            console.error('[processImport] Erro ao inserir material:', partInsErr);
            throw new Error(`Erro ao cadastrar material "${newPartData.description}": ${partInsErr.message}`);
          }

          // Auditoria de movimentação
          if (insertedPart) {
            await recordStockMovement(supabase, {
              part_id: insertedPart.id,
              movement_type: 'ENTRADA',
              quantity: itemQty,
              unit_value: itemUnitVal,
              previous_stock: 0,
              new_stock: itemQty,
              reference_type: 'NFE_IMPORT',
              reference_id: accessKey,
              reference_label: `NF-e ${invoiceNumber}`,
              notes: `Novo item cadastrado via NF-e nº ${invoiceNumber} (${parsed_data.issuer?.name || 'Fornecedor'}).`,
              created_by: req.user?.id || null,
            });
          }

          partsCreated++;
        }
      }
    }

    // 2. Process Financial Bills (Contas a Pagar / Receber)
    const paymentType = payment_config?.type || 'a_vista';
    const installments = payment_config?.installments || [];

    if (paymentType !== 'nenhum' && installments.length > 0) {
      const billType = parsed_data.operation_type === 'saida' ? 'receivable' : 'payable';
      const counterpartyName = parsed_data.issuer?.fantasy_name || parsed_data.issuer?.name || 'Fornecedor NF-e';

      for (let i = 0; i < installments.length; i++) {
        const inst = installments[i];
        const instNumber = inst.installment_number || (i + 1);
        const billDescription = installments.length > 1
          ? `NF-e ${invoiceNumber} - Parcela ${instNumber}/${installments.length} - ${counterpartyName}`
          : `NF-e ${invoiceNumber} - ${counterpartyName}`;

        const rawAmount = inst.amount != null ? inst.amount : (inst.value != null ? inst.value : null);
        let finalAmount = rawAmount != null ? Number(rawAmount) : NaN;

        if (isNaN(finalAmount) || finalAmount <= 0) {
          const totalInvoice = Number(parsed_data.totals?.total_invoice || 0);
          finalAmount = totalInvoice > 0 ? (totalInvoice / installments.length) : 0;
        }

        const billData = {
          origin: 'NFE',
          type: billType,
          counterparty_name: counterpartyName,
          description: billDescription,
          gross_value: finalAmount,
          fee_amount: 0,
          net_value: finalAmount,
          due_date: inst.due_date ? inst.due_date.split('T')[0] : new Date().toISOString().split('T')[0],
          status: 'Pendente',
          barcode: accessKey,
          bank_raw_snapshot: {
            source: 'NFE_IMPORT',
            access_key: accessKey,
            invoice_number: invoiceNumber,
            series: parsed_data.series,
            issue_date: parsed_data.issue_date,
            issuer_cnpj: parsed_data.issuer?.cnpj,
            issuer_name: parsed_data.issuer?.name,
            total_invoice: parsed_data.totals?.total_invoice,
            installment_number: instNumber,
            total_installments: installments.length,
          },
          created_by: req.user?.id || null,
        };

        const { error: billErr } = await supabase.from('bills').insert(billData);
        if (billErr) {
          console.error('[processImport] Erro ao gerar conta a pagar:', billErr);
          throw new Error(`Erro ao gerar fatura/conta a pagar da parcela ${instNumber}: ${billErr.message}`);
        }
        billsCreated++;
      }
    }

    // 3. Record in nfe_imports for history & audit
    const destinationSummary = {
      equipments_created: equipmentsCreated,
      parts_created: partsCreated,
      parts_updated: partsUpdated,
      bills_created: billsCreated,
    };

    const importRecord = {
      access_key: accessKey,
      invoice_number: invoiceNumber,
      series: parsed_data.series || '1',
      operation_type: parsed_data.operation_type || 'entrada',
      issue_date: parsed_data.issue_date || new Date().toISOString(),
      issuer_name: parsed_data.issuer?.name || '',
      issuer_cnpj: parsed_data.issuer?.cnpj || '',
      recipient_name: parsed_data.recipient?.name || null,
      recipient_cnpj: parsed_data.recipient?.cnpj || null,
      total_products: parsed_data.totals?.total_products || 0,
      total_invoice: parsed_data.totals?.total_invoice || 0,
      payment_type: paymentType,
      installments_count: installments.length,
      raw_xml: xml || null,
      parsed_json: parsed_data,
      destination_summary: destinationSummary,
      created_by: req.user?.id || null,
    };

    const { data: insertedImport, error: importLogErr } = await supabase
      .from('nfe_imports')
      .insert(importRecord)
      .select()
      .single();

    if (importLogErr) {
      console.error('[processImport] Erro ao gravar log de importação:', importLogErr);
    }

    return res.status(201).json({
      success: true,
      message: `NF-e nº ${invoiceNumber} importada e processada com sucesso!`,
      summary: destinationSummary,
      import_id: insertedImport?.id || null,
    });
  } catch (error: any) {
    console.error('[processImport] Erro no processamento da NF-e:', error);
    return res.status(500).json({ error: error.message || 'Erro interno ao processar NF-e.' });
  }
};

export const listImports = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('nfe_imports')
      .select('id, access_key, invoice_number, series, operation_type, issue_date, issuer_name, issuer_cnpj, total_invoice, payment_type, installments_count, destination_summary, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getImportById = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('nfe_imports')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
