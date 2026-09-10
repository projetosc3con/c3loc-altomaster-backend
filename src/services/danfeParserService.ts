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

function isValidCompanyName(str?: string | null): boolean {
  if (!str) return false;
  const s = str.trim();
  if (s.length < 3) return false;
  if (/^(CNPJ|CPF|DATA|ENDERE[ÇC]O|BAIRRO|MUNIC[ÍI]PIO|FONE|FRETE|INSCRI[ÇC][ÃA]O|DOCUMENTO|CHAVE|N[º°]|S[ÉE]RIE|PROTOCOLO|NATUREZA|DESTINAT|REMETENTE|FATURA|C[ÁA]LCULO|VALOR|BASE)/i.test(s)) {
    return false;
  }
  if (/\b(CNPJ\s*\/?\s*CPF|DATA\s*(?:DA\s*)?EMISS[ÃA]O|FRETE\s+POR\s+CONTA|VALOR\s+TOTAL)\b/i.test(s)) {
    return false;
  }
  return true;
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

  // Localiza razão social e IE no cabeçalho do emitente
  const emitenteBox = text.substring(0, Math.min(text.length, 1200));
  const ieMatch = emitenteBox.match(/(?:INSCRI[ÇC][ÃA]O\s*ESTADUAL|I\.E\.)[:\s]*([0-9.-]+)/i);
  if (ieMatch && ieMatch[1]) {
    issuerIe = ieMatch[1].trim();
  }

  // Município / UF do emitente (ex: Indaiatuba - SP)
  const cityStateMatch = emitenteBox.match(/([A-Za-zÀ-ÿ ]{3,30})\s*-\s*([A-Z]{2})\b/);
  if (cityStateMatch) {
    issuerCity = cityStateMatch[1].trim();
    issuerState = cityStateMatch[2].trim();
  }

  // 1. Canhoto de recebimento: "RECEBEMOS DE [RAZÃO SOCIAL] OS PRODUTOS..."
  const canhotoMatch = text.match(/RECEB(?:EMOS|I(?:\/EMOS|\(EMOS\))?)\s+DE\s+([^\n\r]+?)(?:\s+(?:OS\s+PRODUTOS|AS\s+MERCADORIAS|OS\s+SERVI[ÇC]OS|CONSTANTES|INDICAD|DA\s+NF|DA\s+NOTA)|$)/i);
  if (canhotoMatch && canhotoMatch[1] && isValidCompanyName(canhotoMatch[1])) {
    issuerName = canhotoMatch[1].trim();
  }

  // 2. Busca nas linhas antes do cabeçalho "DANFE" (bloco de identificação do emitente)
  if (!issuerName) {
    const danfePos = text.indexOf('DANFE');
    if (danfePos > 10) {
      const beforeDanfe = text.substring(0, danfePos).trim();
      const lines = beforeDanfe.split('\n').map((l) => l.trim()).filter((l) => l.length > 2);
      const candidate = lines.find((l) => {
        if (/^(RECEB|CONSULTA|AUTENTICIDADE|SEFAZ|PORTAL|FAZENDA|IDENTIFICA|DATA\s+DE|N[º°]|S[ÉE]RIE|\d+$|0\s*-\s*ENTRADA|1\s*-\s*SA)/i.test(l)) {
          return false;
        }
        return isValidCompanyName(l);
      });
      if (candidate) {
        issuerName = candidate;
      }
    }
  }

  // 3. Rótulo explícito "IDENTIFICAÇÃO DO EMITENTE"
  if (!issuerName) {
    const razaoMatch = text.match(/IDENTIFICA[ÇC][ÃA]O\s*(?:DO\s*)?EMITENTE[:\s]*([^\n\r]+)/i);
    if (razaoMatch && razaoMatch[1] && isValidCompanyName(razaoMatch[1])) {
      issuerName = razaoMatch[1].trim();
    }
  }

  // 4. Caso não tenha rótulo explícito, linhas após o título DANFE
  if (!issuerName) {
    const danfePos = text.indexOf('DANFE');
    if (danfePos !== -1) {
      const destIndex = text.search(/DESTINAT[ÁA]RIO\s*\/?\s*REMETENTE/i);
      const section = text.substring(danfePos + 5, destIndex !== -1 ? destIndex : danfePos + 800);
      const lines = section
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => {
          if (l.length < 3) return false;
          if (/^(DOCUMENTO\s*AUXILIAR|CHAVE|CONSULTA|0\s*-\s*ENTRADA|1\s*-\s*SA|N[º°]|S[ÉE]RIE|FOLHA|PROTOCOLO|NATUREZA)/i.test(l)) return false;
          return isValidCompanyName(l);
        });
      if (lines.length > 0) {
        issuerName = lines[0];
      }
    }
  }

  if (!issuerName) {
    issuerName = `Fornecedor CNPJ ${issuerCnpj}`;
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
    if (nameMatch && nameMatch[1] && isValidCompanyName(nameMatch[1])) {
      recipientName = nameMatch[1].trim();
    }

    // Fallback: varre linhas do quadro de destinatário procurando linha com Razão Social seguida de CNPJ
    if (!recipientName) {
      const lines = destSection.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (/DESTINAT[ÁA]RIO/i.test(line)) continue;
        const lineMatch = line.match(/^([^\d]+?)\s+(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})/);
        if (lineMatch) {
          const candName = lineMatch[1].trim();
          if (isValidCompanyName(candName)) {
            recipientName = candName;
            if (!recipientCnpj) recipientCnpj = lineMatch[2].trim();
            break;
          }
        }
      }
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

    // Linhas fiscais contêm: NCM (8 dig ou 4.2.2), CST (3-4 dig), CFOP (4 dig), UN, QTD, VL_UNIT, [num3], [num4]
    const fiscalRegex = /(\d{8}|\d{4}\.\d{2}\.\d{2})\s+(\d{3,4})\s+([1-7]\d{3})\s+([A-Za-z0-9/²³º°]{1,10})\s+([0-9.,]+)\s+([0-9.,]+)(?:\s+([0-9.,]+))?(?:\s+([0-9.,]+))?/;

    const isHeaderLine = (l: string) => {
      return (
        /^(DADOS\s*DO\s*PRODUTO|TRANSPORTADOR|VOLUMES|RAZ[ÃA]O\s*SOCIAL|FRETE|ENDERE[ÇC]O|ESP[ÉE]CIE|MARCA|PESO|COD\.?\s*PROD|DESCRI[ÇC]|NCM|CST|CFOP|QTDE?|QUANT|UNID?|VL\.?\s*UNIT|VALOR|AL[ÍI]Q|BC\.?\s*ICMS|V\.?\s*IPI)/i.test(l) &&
        !fiscalRegex.test(l)
      );
    };

    let pendingDescriptionLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isHeaderLine(line)) {
        continue;
      }

      const fiscalMatch = line.match(fiscalRegex);
      if (fiscalMatch) {
        const textBeforeFiscal = line.substring(0, fiscalMatch.index).trim();
        let fullItemHeader = '';

        if (pendingDescriptionLines.length > 0) {
          let joined = pendingDescriptionLines[0];
          for (let j = 1; j < pendingDescriptionLines.length; j++) {
            const prev = joined;
            const curr = pendingDescriptionLines[j];
            // Se a linha anterior terminar com hífen ou quebra de palavra monossílaba/consoante solta (ex: " COMO P" + "ROTECAO")
            if (prev.endsWith('-')) {
              joined = prev.slice(0, -1) + curr;
            } else if (/(?:^|\s)[b-df-hj-np-tv-z]$/i.test(prev) && /^[a-záàâãéêíóôõúç]/i.test(curr)) {
              joined = prev + curr;
            } else {
              joined = prev + ' ' + curr;
            }
          }
          fullItemHeader = textBeforeFiscal ? `${joined} ${textBeforeFiscal}` : joined;
          pendingDescriptionLines = [];
        } else {
          fullItemHeader = textBeforeFiscal;
        }

        fullItemHeader = fullItemHeader.trim();

        let productCode = '';
        let description = fullItemHeader;

        // Se o cabeçalho começar com um código de produto (alfanumérico sem espaços) seguido da descrição
        const codeMatch = fullItemHeader.match(/^(\S+)\s+(.+)$/);
        if (codeMatch) {
          productCode = codeMatch[1];
          description = codeMatch[2].trim();
        } else if (fullItemHeader) {
          productCode = String(items.length + 1);
          description = fullItemHeader;
        } else {
          productCode = String(items.length + 1);
          description = `Item ${items.length + 1}`;
        }

        const ncm = fiscalMatch[1].replace(/\D/g, '');
        const cst = fiscalMatch[2];
        const cfop = fiscalMatch[3];
        const rawUnit = fiscalMatch[4];
        const unit = normalizeUnit(rawUnit);
        const quantity = parseMoney(fiscalMatch[5]);
        const unitValue = parseMoney(fiscalMatch[6]);

        const num3 = fiscalMatch[7] ? parseMoney(fiscalMatch[7]) : null;
        const num4 = fiscalMatch[8] ? parseMoney(fiscalMatch[8]) : null;

        let discountValue = 0;
        let totalValue = 0;

        const calcExpected = Number((quantity * unitValue).toFixed(2));

        if (num4 !== null && num3 !== null) {
          // Layout com coluna de desconto: QTDE, VLR_UNIT, VLR_TOT, VLR_DESC
          if (Math.abs(calcExpected - num3) <= 0.05) {
            totalValue = num3;
            discountValue = num4;
          } else if (Math.abs((calcExpected - num3) - num4) <= 0.05 || (num3 === 0 && Math.abs(calcExpected - num4) <= 0.05)) {
            // Layout com coluna de desconto antes: QTDE, VLR_UNIT, VLR_DESC, VLR_TOT
            discountValue = num3;
            totalValue = num4;
          } else {
            totalValue = num3 > 0 ? num3 : (num4 > 0 ? num4 : calcExpected);
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
      } else {
        // Linha sem dados fiscais: acumula texto/continuação da descrição de produto
        pendingDescriptionLines.push(line);
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
