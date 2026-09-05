import { extractText } from 'unpdf';
import {
  ParsedNfeData,
  ParsedNfeItem,
  ParsedNfeInstallment,
  inferSuggestedDestination,
  normalizeUnit,
} from './nfeParserService';
import { isNfseDocument, parseNfsePdf } from './nfseParserService';

function parseMoney(raw?: string | null): number {
  if (!raw) return 0;
  let clean = raw.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (!clean) return 0;

  // Se tiver ponto e vírgula, ex: 1.234,56
  if (clean.includes('.') && clean.includes(',')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
    // Ex: 1234,56
    clean = clean.replace(',', '.');
  }
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : Number(val.toFixed(2));
}

function parseDateToIso(dateStr?: string | null): string {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    return `${yyyy}-${mm}-${dd}`;
  }
  return new Date().toISOString().split('T')[0];
}

function formatCnpj(digits: string): string {
  const c = digits.replace(/\D/g, '').padStart(14, '0');
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

export async function parseDanfePdf(pdfBuffer: Buffer): Promise<ParsedNfeData> {
  const { text } = await extractText(new Uint8Array(pdfBuffer), { mergePages: true });

  if (!text || text.trim().length === 0) {
    throw new Error(
      'Não foi possível extrair texto do arquivo PDF. Certifique-se de que o documento é um PDF fiscal digital e não uma imagem escaneada.'
    );
  }

  // Se for Nota Fiscal de Serviços (NFS-e), direciona para o parser especializado de NFS-e
  if (isNfseDocument(text)) {
    return parseNfsePdf(pdfBuffer, text);
  }

  // 1. Extração da Chave de Acesso (44 dígitos numéricos)
  let accessKey = '';
  // Padrões comuns: 44 dígitos diretos ou 11 blocos de 4 dígitos (ex: 3524 0912 ...)
  const keyMatches = text.match(/\b(?:\d{4}[\s-]?){11}\b/g) || text.match(/\b\d{44}\b/g);
  if (keyMatches && keyMatches.length > 0) {
    for (const km of keyMatches) {
      const clean = km.replace(/\D/g, '');
      if (clean.length === 44) {
        accessKey = clean;
        break;
      }
    }
  }

  // Se não encontrou em bloco contínuo, busca próximo à palavra "CHAVE DE ACESSO"
  if (!accessKey) {
    const chaveIndex = text.indexOf('CHAVE DE ACESSO');
    if (chaveIndex !== -1) {
      const windowAround = text.substring(chaveIndex, chaveIndex + 200);
      const digitsOnly = windowAround.replace(/\D/g, '');
      if (digitsOnly.length >= 44) {
        accessKey = digitsOnly.substring(0, 44);
      }
    }
  }

  // Se ainda assim não encontrar chave de acesso
  if (!accessKey || accessKey.length !== 44) {
    throw new Error(
      'Chave de acesso da NF-e (44 dígitos) não foi localizada no arquivo PDF. Verifique se o arquivo enviado é uma DANFE válida.'
    );
  }

  // Desestruturação da chave de 44 dígitos segundo padrão nacional SEFAZ:
  // cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + serie(3) + nNF(9) + tpEmis(1) + cNF(8) + cDV(1)
  const keyYearMonth = accessKey.substring(2, 6);
  const keyIssuerCnpjDigits = accessKey.substring(6, 20);
  const keySeriesRaw = accessKey.substring(22, 25);
  const keyInvoiceNumRaw = accessKey.substring(25, 34);

  const decodedSeries = String(parseInt(keySeriesRaw, 10) || 1);
  const decodedInvoiceNumber = String(parseInt(keyInvoiceNumRaw, 10) || '');

  // 2. Número e Série
  let invoiceNumber = decodedInvoiceNumber;
  let series = decodedSeries;

  const numMatch = text.match(/(?:N[º°o]\.?\s*|NÚMERO[:\s]*)([0-9]{1,3}(?:\.[0-9]{3})*|\d+)/i);
  if (numMatch && numMatch[1]) {
    const foundNum = numMatch[1].replace(/\./g, '');
    if (foundNum) invoiceNumber = foundNum;
  }

  const serieMatch = text.match(/(?:S[ÉE]RIE|SERIE)[:\s]*(\d{1,3})/i);
  if (serieMatch && serieMatch[1]) {
    series = serieMatch[1];
  }

  // 3. Data de Emissão
  let issueDate = '';
  const dateMatch = text.match(/(?:DATA\s*(?:DA\s*)?EMISS[ÃA]O|EMISS[ÃA]O)[:\s]*(\d{2}\/\d{2}\/\d{4})/i);
  if (dateMatch && dateMatch[1]) {
    issueDate = parseDateToIso(dateMatch[1]);
  } else if (keyYearMonth) {
    const yy = keyYearMonth.substring(0, 2);
    const mm = keyYearMonth.substring(2, 4);
    issueDate = `20${yy}-${mm}-01`;
  } else {
    issueDate = new Date().toISOString().split('T')[0];
  }

  // 4. Natureza da Operação
  let natureOfOperation = 'Compra / Entrada de Mercadoria';
  const natMatch = text.match(/(?:NATUREZA\s*(?:DA\s*)?OPERA[ÇC][ÃA]O)[:\s]*([^\n\r]+)/i);
  if (natMatch && natMatch[1]) {
    natureOfOperation = natMatch[1].trim();
  }

  // 5. Emitente (Fornecedor)
  const issuerCnpj = formatCnpj(keyIssuerCnpjDigits);
  let issuerName = '';
  let issuerIe = '';
  let issuerCity = '';
  let issuerState = '';

  // Localiza razão social do emitente no cabeçalho
  const emitenteBox = text.substring(0, Math.min(text.length, 1200));
  const ieMatch = emitenteBox.match(/(?:INSCRI[ÇC][ÃA]O\s*ESTADUAL|I\.E\.)[:\s]*([0-9.-]+)/i);
  if (ieMatch && ieMatch[1]) {
    issuerIe = ieMatch[1].trim();
  }

  // Busca linhas antes de "DANFE"
  const danfePos = text.indexOf('DANFE');
  if (danfePos > 10) {
    const beforeDanfe = text.substring(0, danfePos).trim();
    const lines = beforeDanfe.split('\n').map((l) => l.trim()).filter((l) => l.length > 3);
    if (lines.length > 0) {
      issuerName = lines[0];
    }
  }

  if (!issuerName) {
    const razaoMatch = text.match(/(?:RAZ[ÃA]O\s*SOCIAL|EMITENTE)[:\s]*([^\n\r]+)/i);
    if (razaoMatch && razaoMatch[1]) {
      issuerName = razaoMatch[1].trim();
    } else {
      issuerName = `Fornecedor CNPJ ${issuerCnpj}`;
    }
  }

  // 6. Destinatário
  let recipientCnpj = '';
  let recipientName = '';
  const destIndex = text.search(/DESTINAT[ÁA]RIO\s*\/?\s*REMETENTE/i);
  if (destIndex !== -1) {
    const destSection = text.substring(destIndex, destIndex + 600);
    const cnpjMatch = destSection.match(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})\b/);
    if (cnpjMatch) {
      recipientCnpj = cnpjMatch[1];
    }
    const nameMatch = destSection.match(/(?:NOME\s*\/\s*RAZ[ÃA]O\s*SOCIAL)[:\s]*([^\n\r]+)/i);
    if (nameMatch && nameMatch[1]) {
      recipientName = nameMatch[1].trim();
    }
  }

  // 7. Totais e Impostos
  const totalProductsMatch = text.match(/(?:VALOR\s*TOTAL\s*(?:DOS\s*)?PROD(?:UTOS)?\.?|V(?:ALOR)?\.?\s*PROD\.?)[:\s]*([0-9.,]+)/i);
  const totalInvoiceMatch = text.match(/(?:VALOR\s*TOTAL\s*(?:DA\s*)?NOTA\.?|V(?:ALOR)?\.?\s*TOTAL\.?|V(?:ALOR)?\.?\s*NF\.?)[:\s]*([0-9.,]+)/i);
  const freightMatch = text.match(/(?:VALOR\s*(?:DO\s*)?FRETE|V(?:ALOR)?\.?\s*FRETE)[:\s]*([0-9.,]+)/i);
  const insuranceMatch = text.match(/(?:VALOR\s*(?:DO\s*)?SEGURO|V(?:ALOR)?\.?\s*SEG\.?)[:\s]*([0-9.,]+)/i);
  const discountMatch = text.match(/(?:DESCONTO|DESC\.?)[:\s]*([0-9.,]+)/i);
  const otherMatch = text.match(/(?:OUTRAS\s*DESP(?:ESAS)?\.?|OUTRAS)[:\s]*([0-9.,]+)/i);
  const icmsMatch = text.match(/(?:VALOR\s*(?:DO\s*)?ICMS|V(?:ALOR)?\.?\s*ICMS)[:\s]*([0-9.,]+)/i);
  const ipiMatch = text.match(/(?:VALOR\s*(?:DO\s*)?IPI|V(?:ALOR)?\.?\s*IPI)[:\s]*([0-9.,]+)/i);
  const pisMatch = text.match(/(?:VALOR\s*(?:DO\s*)?PIS|V(?:ALOR)?\.?\s*PIS)[:\s]*([0-9.,]+)/i);
  const cofinsMatch = text.match(/(?:VALOR\s*(?:DA\s*)?COFINS|V(?:ALOR)?\.?\s*COFINS)[:\s]*([0-9.,]+)/i);

  const totalInvoice = parseMoney(totalInvoiceMatch?.[1]);
  const totalProducts = parseMoney(totalProductsMatch?.[1]) || totalInvoice;
  const totalFreight = parseMoney(freightMatch?.[1]);
  const totalInsurance = parseMoney(insuranceMatch?.[1]);
  const totalDiscount = parseMoney(discountMatch?.[1]);
  const totalOther = parseMoney(otherMatch?.[1]);
  const totalIcms = parseMoney(icmsMatch?.[1]);
  const totalIpi = parseMoney(ipiMatch?.[1]);
  const totalPis = parseMoney(pisMatch?.[1]);
  const totalCofins = parseMoney(cofinsMatch?.[1]);

  // 8. Fatura / Duplicatas (Parcelamento)
  const installments: ParsedNfeInstallment[] = [];
  const faturaIndex = text.search(/FATURA\s*\/?\s*DUPLICATAS|DADOS\s*DA\s*FATURA|DUPLICATAS/i);

  if (faturaIndex !== -1) {
    const faturaSection = text.substring(faturaIndex, faturaIndex + 800);
    // Padrão comum de duplicata: Número Vencimento Valor (ex: 001 25/10/2024 1.500,00 ou 01 25/10/2024 1500,00)
    const dupRegex = /(\d{1,4}|\d{1,3}\/\d{1,3})\s+(\d{2}\/\d{2}\/\d{4})\s+([0-9.,]+)/g;
    let match: RegExpExecArray | null;

    while ((match = dupRegex.exec(faturaSection)) !== null) {
      const instNum = parseInt(match[1].replace(/\D/g, ''), 10) || (installments.length + 1);
      const dueDate = parseDateToIso(match[2]);
      const amount = parseMoney(match[3]);

      if (amount > 0) {
        installments.push({
          installment_number: String(instNum),
          due_date: dueDate,
          amount,
        });
      }
    }
  }

  // Fallback se não encontrou duplicatas estruturadas: 1 parcela única com valor da nota
  if (installments.length === 0 && totalInvoice > 0) {
    installments.push({
      installment_number: '1',
      due_date: issueDate,
      amount: totalInvoice,
    });
  }

  // 9. Dados dos Produtos / Serviços
  const items: ParsedNfeItem[] = [];
  const prodIndex = text.search(/DADOS\s*DO(?:S)?\s*PRODUTO(?:S)?\s*\/?\s*SERVI[ÇC]O(?:S)?/i);

  if (prodIndex !== -1) {
    // Pega da seção de produtos até dados adicionais ou cálculo do ISSQN
    let prodSection = text.substring(prodIndex);
    const endProdIndex = prodSection.search(/C[ÁA]LCULO\s*DO\s*ISSQN|DADOS\s*ADICIONAIS|INFORMA[ÇC][ÕO]ES\s*COMPLEMENTARES/i);
    if (endProdIndex !== -1) {
      prodSection = prodSection.substring(0, endProdIndex);
    }

    const lines = prodSection.split('\n').map((l) => l.trim()).filter(Boolean);

    // Linha de produto típica: [CÓDIGO] [DESCRIÇÃO] [NCM 8 dig] [CST] [CFOP 4 dig] [UN] [QTD] [VLR UNIT] [VLR DESC (opcional)] [VLR TOT]
    const itemRegex = /^(?:(\S+)\s+)?(.+?)\s+(\d{8}|\d{4}\.\d{2}\.\d{2})\s+(\d{3,4})\s+([1-7]\d{3})\s+([A-Za-z0-9/²³º°]{1,10})\s+([0-9.,]+)\s+([0-9.,]+)(?:\s+([0-9.,]+))?(?:\s+([0-9.,]+))?/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(itemRegex);

      if (match) {
        const productCode = match[1] || String(items.length + 1);
        const description = match[2].trim();
        const ncm = match[3].replace(/\D/g, '');
        const cst = match[4];
        const cfop = match[5];
        const rawUnit = match[6];
        const unit = normalizeUnit(rawUnit);
        const quantity = parseMoney(match[7]);
        const unitValue = parseMoney(match[8]);

        const num3 = match[9] ? parseMoney(match[9]) : null;
        const num4 = match[10] ? parseMoney(match[10]) : null;

        let discountValue = 0;
        let totalValue = 0;

        const calcExpected = Number((quantity * unitValue).toFixed(2));

        if (num4 !== null && num3 !== null) {
          // Layout com coluna de desconto: QTDE, VLR_UNIT, VLR_DESC, VLR_TOT
          if (Math.abs((calcExpected - num3) - num4) <= 0.05 || (num3 === 0 && Math.abs(calcExpected - num4) <= 0.05)) {
            discountValue = num3;
            totalValue = num4;
          } else if (Math.abs(calcExpected - num3) <= 0.05) {
            // Se num3 for o total líquido
            totalValue = num3;
          } else {
            totalValue = num4 > 0 ? num4 : calcExpected;
          }
        } else if (num3 !== null) {
          totalValue = num3 > 0 ? num3 : calcExpected;
        } else {
          totalValue = calcExpected;
        }

        const inference = inferSuggestedDestination({
          description,
          ncm,
          cfop,
          unit_value: unitValue,
        });

        items.push({
          item_index: items.length + 1,
          product_code: productCode,
          description,
          ncm,
          cst_icms: cst,
          cfop,
          unit,
          quantity: quantity > 0 ? quantity : 1,
          unit_value: unitValue > 0 ? unitValue : totalValue,
          total_value: totalValue > 0 ? totalValue : Number((unitValue * (quantity || 1)).toFixed(2)),
          discount_value: discountValue,
          net_item_value: totalValue > 0 ? totalValue : Number((unitValue * (quantity || 1)).toFixed(2)),
          tax_details: {},
          suggested_destination: inference.destination,
          extracted_serial_number: inference.serial_number,
          extracted_model: inference.model,
        });
      }
    }
  }

  // Fallback: se nenhum item da tabela foi capturado com o regex estrito, cria um item consolidado
  if (items.length === 0) {
    const fallbackDesc = `Itens e materiais da NF-e nº ${invoiceNumber}`;
    const inference = inferSuggestedDestination({
      description: fallbackDesc,
      ncm: '',
      cfop: '5102',
      unit_value: totalInvoice || totalProducts || 0,
    });

    const fallbackVal = totalInvoice || totalProducts || 0;
    items.push({
      item_index: 1,
      product_code: 'NFE-001',
      description: fallbackDesc,
      ncm: '',
      cst_icms: '00',
      cfop: '5102',
      unit: 'UN',
      quantity: 1,
      unit_value: fallbackVal,
      total_value: fallbackVal,
      discount_value: totalDiscount,
      net_item_value: fallbackVal,
      tax_details: {
        icms_value: totalIcms,
        ipi_value: totalIpi,
        pis_value: totalPis,
        cofins_value: totalCofins,
      },
      suggested_destination: inference.destination,
      extracted_serial_number: inference.serial_number,
      extracted_model: inference.model,
    });
  }

  // 10. Informações Complementares / Adicionais
  let additionalInfo: string | undefined = undefined;
  const adicIndex = text.search(/DADOS\s*ADICIONAIS|INFORMA[ÇC][ÕO]ES\s*COMPLEMENTARES/i);
  if (adicIndex !== -1) {
    const adicSection = text.substring(adicIndex, adicIndex + 500);
    additionalInfo = adicSection.replace(/DADOS\s*ADICIONAIS|INFORMA[ÇC][ÕO]ES\s*COMPLEMENTARES[:\s]*/i, '').trim();
  }

  return {
    access_key: accessKey,
    invoice_number: invoiceNumber,
    series,
    issue_date: issueDate,
    operation_type: 'entrada',
    nature_of_operation: natureOfOperation,
    issuer: {
      cnpj: issuerCnpj,
      name: issuerName,
      ie: issuerIe || undefined,
      city: issuerCity || undefined,
      state: issuerState || undefined,
    },
    recipient: {
      cnpj: recipientCnpj,
      name: recipientName,
    },
    items,
    totals: {
      total_products: totalProducts,
      total_discount: totalDiscount,
      total_freight: totalFreight,
      total_insurance: totalInsurance,
      total_other: totalOther,
      total_invoice: totalInvoice || totalProducts,
      total_icms: totalIcms,
      total_pis: totalPis,
      total_cofins: totalCofins,
      total_ipi: totalIpi,
    },
    installments,
    additional_info: additionalInfo,
    document_type: 'nfe',
  };
}
