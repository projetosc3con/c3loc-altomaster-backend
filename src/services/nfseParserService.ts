import { extractText } from 'unpdf';
import { ParsedNfeData, ParsedNfeItem } from './nfeParserService';

function parseMoney(raw?: string | null): number {
  if (!raw) return 0;
  let clean = raw.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (!clean) return 0;

  if (clean.includes('.') && clean.includes(',')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
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

/**
 * Identifica se o texto extraído do PDF é uma Nota Fiscal de Serviço (NFS-e)
 */
export function isNfseDocument(text: string): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();

  const nfseKeywords = [
    'NOTA FISCAL DE SERVIÇOS ELETRÔNICA',
    'NOTA FISCAL DE SERVICOS ELETRONICA',
    'NFS-E',
    'PRESTADOR DE SERVIÇOS',
    'PRESTADOR DE SERVICOS',
    'TOMADOR DE SERVIÇOS',
    'TOMADOR DE SERVICOS',
    'DISCRIMINAÇÃO DOS SERVIÇOS',
    'DISCRIMINACAO DOS SERVICOS',
    'CÓDIGO DE VERIFICAÇÃO',
    'CODIGO DE VERIFICACAO',
  ];

  let matches = 0;
  for (const kw of nfseKeywords) {
    if (upper.includes(kw)) matches++;
  }

  // Se tiver "DANFE" ou "MODELO 55" e poucas palavras de NFS-e, é NF-e de produto
  if (upper.includes('DANFE') && upper.includes('DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA')) {
    return false;
  }

  return matches >= 2;
}

/**
 * Parser especializado para Notas Fiscais de Serviços (NFS-e) em PDF
 */
export async function parseNfsePdf(pdfBuffer: Buffer, preExtractedText?: string): Promise<ParsedNfeData> {
  let text = preExtractedText || '';
  if (!text) {
    const { text: extracted } = await extractText(new Uint8Array(pdfBuffer), { mergePages: true });
    text = extracted || '';
  }

  if (!text || text.trim().length === 0) {
    throw new Error('Não foi possível extrair texto do documento NFS-e.');
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // 1. Número da Nota
  let invoiceNumber = '';
  const numMatches = [
    text.match(/\b\d{4}\.\d{11}\b/), // Ex: 0000.00000026512
    text.match(/(?:N[ÚU]MERO\s*(?:DA\s*)?NOTA|N[ÚU]MERO\s*(?:DA\s*)?NFS-E|Nº\s*NOTA)[:\s]*([0-9.]+)/i),
    text.match(/NFS-e\s*N[º°]?\s*([0-9.]+)/i),
  ];

  for (const m of numMatches) {
    if (m && m[1]) {
      invoiceNumber = m[1].replace(/\./g, '').replace(/^0+/, '');
      if (invoiceNumber) break;
    } else if (m && m[0] && m[0].includes('.')) {
      invoiceNumber = m[0].replace(/\./g, '').replace(/^0+/, '');
      if (invoiceNumber) break;
    }
  }

  if (!invoiceNumber) {
    invoiceNumber = '1';
  }

  // Série
  let series = 'NFS';
  const serieMatch = text.match(/S[ÉE]RIE[:\s]*([0-9A-Za-z]+)/i);
  if (serieMatch && serieMatch[1]) {
    series = serieMatch[1].trim();
  }

  // 2. Data de Emissão
  let issueDate = new Date().toISOString().split('T')[0];
  const dateMatch =
    text.match(/(\d{2}\/\d{2}\/\d{4})\s+\d{2}:\d{2}:\d{2}/) ||
    text.match(/(?:DATA\s*(?:E\s*HORA\s*)?(?:DA\s*)?EMISS[ÃA]O|EMISS[ÃA]O)[:\s]*(\d{2}\/\d{2}\/\d{4})/i);

  if (dateMatch && dateMatch[1]) {
    issueDate = parseDateToIso(dateMatch[1]);
  }

  // 3. Código de Verificação
  let verificationCode = '';
  const verifMatch =
    text.match(/C[ÓO]DIGO\s*DE\s*VERIFICA[ÇC][ÃA]O[\s\S]*?([a-f0-9]{15,40})/i) ||
    text.match(/\b[a-f0-9]{20,35}\b/i);

  if (verifMatch) {
    verificationCode = (verifMatch[1] || verifMatch[0]).replace(/\s+/g, '');
  }

  // 4. Prestador e Tomador
  const cnpjs = text.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g) || [];
  const issuerCnpj = cnpjs[0] || '00.000.000/0000-00';
  const recipientCnpj = cnpjs[1] || '';

  let issuerName = '';
  let issuerIe = '';
  let issuerCity = '';
  let issuerState = '';

  const prestadorIdx = lines.findIndex((l) => /PRESTADOR\s*DE\s*SERVI[ÇC]OS/i.test(l));
  if (prestadorIdx !== -1) {
    // Procura razão social nas próximas linhas
    for (let i = prestadorIdx + 1; i < Math.min(lines.length, prestadorIdx + 8); i++) {
      const line = lines[i];
      if (
        line.length > 3 &&
        !line.includes('CNPJ') &&
        !line.includes('INSCRIÇÃO') &&
        !line.includes('CEP') &&
        !line.includes('PRESTADOR')
      ) {
        issuerName = line;
        break;
      }
    }
  }

  if (!issuerName) {
    issuerName = `Prestador de Serviços CNPJ ${issuerCnpj}`;
  }

  // Inscrição Municipal / Estadual do Prestador
  const imMatch = text.match(/(?:INSCRI[ÇC][ÃA]O\s*MUNICIPAL)[:\s]*([0-9.-]+)/i);
  if (imMatch && imMatch[1]) {
    issuerIe = imMatch[1].trim();
  }

  let recipientName = '';
  const tomadorNameMatch = text.match(/NOME\s*\/\s*RAZ[ÃA]O[ \t]+([^\n\r]+)/i);
  if (tomadorNameMatch && tomadorNameMatch[1]) {
    recipientName = tomadorNameMatch[1].trim();
  }

  if (!recipientName) {
    const tomadorIdx = lines.findIndex((l) => /TOMADOR\s*DE\s*SERVI[ÇC]OS/i.test(l));
    if (tomadorIdx !== -1) {
      for (let i = Math.max(0, tomadorIdx - 5); i < Math.min(lines.length, tomadorIdx + 6); i++) {
        const line = lines[i];
        if (
          (line.includes('ALTO MASTER') || line.includes('LTDA') || line.includes('S/A') || line.includes('ME')) &&
          !line.includes('PRESTADOR') &&
          (!issuerName || !line.includes(issuerName))
        ) {
          recipientName = line.replace(/NOME\s*\/\s*RAZ[ÃA]O[:\s]*/i, '').trim();
          break;
        }
      }
    }
  }

  // 5. Valores e Totais
  let totalInvoice = 0;
  const totalMatches = [
    text.match(/VALOR\s*TOTAL\s*DA\s*NOTA\s*=\s*([0-9.,]+)/i),
    text.match(/TOTAL\s*L[ÍI]QUIDO\s*DA\s*NOTA[\s\S]*?([0-9.,]+)/i),
    text.match(/VALOR\s*TOTAL\s*DOS\s*SERVI[ÇC]OS[\s\S]*?([0-9.,]+)/i),
  ];

  for (const m of totalMatches) {
    if (m && m[1]) {
      const v = parseMoney(m[1]);
      if (v > 0) {
        totalInvoice = v;
        break;
      }
    }
  }

  // Impostos (ISS)
  let totalIss = 0;
  const issMatch = text.match(/VALOR\s*DO\s*ISS[\s\S]*?([0-9.,]+)/i);
  if (issMatch && issMatch[1]) {
    totalIss = parseMoney(issMatch[1]);
  }

  // 6. Discriminação dos Serviços (Itens)
  const items: ParsedNfeItem[] = [];
  const discIdx = lines.findIndex((l) => /DISCRIMINA[ÇC][ÃA]O\s*DOS\s*SERVI[ÇC]OS/i.test(l));

  let serviceLines: string[] = [];
  if (discIdx !== -1) {
    for (let i = discIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (
        /C[ÓO]DIGO\s*DE\s*CLASSIFICA[ÇC][ÃA]O|BASE\s*DE\s*C[ÁA]LCULO|VALOR\s*TOTAL\s*DA\s*NOTA|OUTRAS\s*INFORMA/i.test(
          l
        )
      ) {
        break;
      }
      if (!l.includes('Quantidade Valor Unitário') && !l.includes('Item Quantidade')) {
        serviceLines.push(l);
      }
    }
  }

  // Linha 1 da discriminação costuma ter a descrição e valores
  let mainDescription = serviceLines[0] || 'Serviços Prestados / Mão de Obra';
  let qty = 1;
  let unitVal = totalInvoice;
  let totVal = totalInvoice;

  if (serviceLines.length > 0) {
    // Tenta formato: [DESCRIÇÃO] [QTD] [VLR_UNIT] [VLR_TOT]
    const itemMatch = serviceLines[0].match(/^(.+?)\s+(\d+)\s+([0-9.,]+)\s+([0-9.,]+)$/);
    if (itemMatch) {
      mainDescription = itemMatch[1].trim();
      qty = parseInt(itemMatch[2], 10) || 1;
      unitVal = parseMoney(itemMatch[3]) || totalInvoice;
      totVal = parseMoney(itemMatch[4]) || totalInvoice;
    }
  }

  // Detalhes complementares (ex: OSs vinculadas, observações técnicas)
  const additionalDetails = serviceLines.slice(1).join(' ').trim();

  // Em NFS-e, serviços não entram no estoque físico de peças.
  // Sugestão padrão: 'ignore' (gera a conta a pagar sem poluir almoxarifado)
  items.push({
    item_index: 1,
    product_code: `SRV-${invoiceNumber}`,
    description: mainDescription,
    ncm: '',
    cfop: '0000',
    unit: 'UN',
    quantity: qty > 0 ? qty : 1,
    unit_value: unitVal > 0 ? unitVal : totalInvoice,
    total_value: totVal > 0 ? totVal : totalInvoice,
    discount_value: 0,
    net_item_value: totVal > 0 ? totVal : totalInvoice,
    tax_details: {
      iss_value: totalIss,
    },
    suggested_destination: 'ignore', // Por padrão, não gera item físico no estoque
  });

  // 7. Chave de acesso sintética padronizada para o banco de dados
  // Formato: NFSE{CNPJ_14}{NUMERO_9} -> Ex: NFSE17631643000136000026512
  const issuerDigits = issuerCnpj.replace(/\D/g, '').padStart(14, '0');
  const numDigits = String(invoiceNumber).replace(/\D/g, '').padStart(9, '0');
  const accessKey = `NFSE${issuerDigits}${numDigits}`;

  // 8. Informações complementares consolidadas
  let additionalInfo = '';
  if (additionalDetails) {
    additionalInfo += `Detalhes do Serviço: ${additionalDetails} `;
  }
  if (verificationCode) {
    additionalInfo += `(Cód. Verificação: ${verificationCode})`;
  }

  return {
    access_key: accessKey,
    invoice_number: invoiceNumber,
    series,
    issue_date: issueDate,
    operation_type: 'entrada',
    nature_of_operation: 'Prestação de Serviços',
    issuer: {
      cnpj: issuerCnpj,
      name: issuerName,
      ie: issuerIe || undefined,
      city: issuerCity || undefined,
      state: issuerState || undefined,
    },
    recipient: {
      cnpj: recipientCnpj,
      name: recipientName || '',
    },
    items,
    totals: {
      total_products: totalInvoice,
      total_discount: 0,
      total_freight: 0,
      total_insurance: 0,
      total_other: 0,
      total_invoice: totalInvoice,
      total_icms: 0,
      total_pis: 0,
      total_cofins: 0,
      total_ipi: 0,
    },
    installments: [
      {
        installment_number: '1',
        due_date: issueDate,
        amount: totalInvoice,
      },
    ],
    additional_info: additionalInfo.trim() || undefined,
    document_type: 'nfse',
    verification_code: verificationCode || undefined,
  };
}
