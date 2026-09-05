import { XMLParser } from 'fast-xml-parser';

export interface ParsedNfeItem {
  item_index: number;
  product_code: string;
  ean?: string;
  description: string;
  ncm: string;
  cfop: string;
  unit: string;
  quantity: number;
  unit_value: number;
  total_value: number;
  discount_value: number;
  net_item_value: number;
  cst_icms?: string;
  icms_rate?: number;
  icms_value?: number;
  ipi_value?: number;
  pis_value?: number;
  cofins_value?: number;
  tax_details: Record<string, any>;
  suggested_destination: 'equipment' | 'part_peca' | 'part_consumo' | 'part_epi' | 'part_outros' | 'ignore';
  extracted_serial_number?: string;
  extracted_model?: string;
}

export interface ParsedNfeInstallment {
  installment_number: string;
  due_date: string;
  amount: number;
}

export interface ParsedNfeData {
  access_key: string;
  invoice_number: string;
  series: string;
  issue_date: string;
  operation_type: 'entrada' | 'saida';
  nature_of_operation: string;
  issuer: {
    cnpj: string;
    name: string;
    fantasy_name?: string;
    ie?: string;
    city?: string;
    state?: string;
    full_address?: string;
  };
  recipient: {
    cnpj: string;
    name: string;
    ie?: string;
    email?: string;
    city?: string;
    state?: string;
  };
  items: ParsedNfeItem[];
  totals: {
    total_products: number;
    total_discount: number;
    total_freight: number;
    total_insurance: number;
    total_other: number;
    total_invoice: number;
    total_icms: number;
    total_pis: number;
    total_cofins: number;
    total_ipi: number;
  };
  installments: ParsedNfeInstallment[];
  additional_info?: string;
  document_type?: 'nfe' | 'nfse';
  verification_code?: string;
}

export function inferSuggestedDestination(item: {
  description: string;
  ncm: string;
  cfop: string;
  unit_value: number;
}): {
  destination: 'equipment' | 'part_peca' | 'part_consumo' | 'part_epi' | 'part_outros';
  serial_number?: string;
  model?: string;
} {
  const desc = item.description.toLowerCase();
  const ncm = (item.ncm || '').trim();

  // Serial number extraction (ex: "SERIE: B300031616" or "S/N: 12345" or "CHASSI: 12345")
  let serial_number: string | undefined;
  const serialMatch = item.description.match(/(?:s[eé]rie|s\/n|chassi|sn)[\s:]+([A-Z0-9_-]+)/i);
  if (serialMatch && serialMatch[1]) {
    serial_number = serialMatch[1].trim();
  }

  // Model extraction (ex: "450AJ", "Z45", "GS1930", "E400AJPN")
  let model: string | undefined;
  const modelMatch = item.description.match(/^([A-Z0-9/.-]{2,15})\b/i);
  if (modelMatch && modelMatch[1]) {
    model = modelMatch[1].trim();
  }

  // 1. Equipamentos / Ativos Imobilizados (NCM 8427, 8428, 8426 ou palavras-chave de máquinas pesadas/locação)
  const isEquipmentNcm = ncm.startsWith('8427') || ncm.startsWith('8428') || ncm.startsWith('8426') || ncm.startsWith('8502');
  const isEquipmentKeyword = /(plataforma|articulad|tesoura|elevat[oó]ri|gerador|torre\s+de\s+ilumina|trator|empilhadeir|manipulador|compressor)/i.test(desc);
  const isAssetCfop = ['1551', '2551', '3551', '1406', '2406', '6102', '5102'].includes(item.cfop) && item.unit_value > 5000;

  if (isEquipmentNcm || isEquipmentKeyword || isAssetCfop) {
    return { destination: 'equipment', serial_number, model };
  }

  // 2. EPI / Segurança
  if (/(luva|capacete|oculos|[oó]culos|protetor|botina|bota|abafador|talabarte|cinto\s+paraquedista|m[aá]scara)/i.test(desc)) {
    return { destination: 'part_epi' };
  }

  // 3. Consumo
  if (/(graxa|[oó]leo|estopa|fita|solvente|desengraxante|fluido|spray|silicone|detergente|aditivo|cola|querosene|gasolina|diesel)/i.test(desc)) {
    return { destination: 'part_consumo' };
  }

  // 4. Peças de reposição por padrão
  return { destination: 'part_peca' };
}

export function normalizeUnit(rawUnit: string): string {
  if (!rawUnit) return 'UN';
  const u = rawUnit.trim().toUpperCase();

  if (['METRO', 'METROS', 'MTR', 'MTRS', 'MTS', 'MT', 'M'].includes(u)) return 'M';
  if (['UN', 'UND', 'UNID', 'UNIDADE', 'PC', 'PCA', 'PECA', 'PEÇA', 'PÇ'].includes(u)) return 'UN';
  if (['L', 'LT', 'LTS', 'LITRO', 'LITROS'].includes(u)) return 'L';
  if (['KG', 'KGS', 'QUILO', 'QUILOS', 'KILO', 'KILOS'].includes(u)) return 'KG';
  if (['G', 'GR', 'GRAMA', 'GRAMAS'].includes(u)) return 'G';
  if (['PAR', 'PARES', 'PR'].includes(u)) return 'PAR';
  if (['CX', 'CXA', 'CAIXA', 'CAIXAS'].includes(u)) return 'CX';
  if (['JG', 'JOGO', 'JOGOS', 'CJ', 'CONJ', 'CONJUNTO'].includes(u)) return 'JG';
  if (['RL', 'ROLO', 'ROLOS'].includes(u)) return 'RL';
  if (['TB', 'TUBO', 'TUBOS'].includes(u)) return 'TB';
  if (['GL', 'GALAO', 'GALÃO'].includes(u)) return 'GL';
  if (['BD', 'BALDE', 'BALDES'].includes(u)) return 'BD';
  if (['LATA', 'LATAS'].includes(u)) return 'LT';

  return u;
}

export function parseNfeXml(xmlString: string): ParsedNfeData {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: true,
    parseAttributeValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlString);

  // Find NFe element (can be inside nfeProc or root NFe)
  const nfeProc = parsed.nfeProc || parsed;
  const nfe = nfeProc.NFe || parsed.NFe;

  if (!nfe || !nfe.infNFe) {
    throw new Error('Formato de XML inválido: elemento <NFe> ou <infNFe> não encontrado.');
  }

  const infNFe = nfe.infNFe;
  const ide = infNFe.ide || {};
  const emit = infNFe.emit || {};
  const dest = infNFe.dest || {};
  const protNFe = nfeProc.protNFe?.infProt || {};

  // Access key from Id or protNFe
  let rawId = infNFe['@_Id'] || '';
  let accessKey = rawId.replace(/^NFe/i, '');
  if (!accessKey && protNFe.chNFe) {
    accessKey = String(protNFe.chNFe);
  }

  // Issuer
  const enderEmit = emit.enderEmit || {};
  const fullAddress = [
    enderEmit.xLgr,
    enderEmit.nro ? `nº ${enderEmit.nro}` : '',
    enderEmit.xBairro,
    enderEmit.xMun ? `${enderEmit.xMun}-${enderEmit.UF || ''}` : '',
    enderEmit.CEP ? `CEP: ${enderEmit.CEP}` : ''
  ].filter(Boolean).join(', ');

  // Items (det can be an array or a single object)
  const detList = Array.isArray(infNFe.det) ? infNFe.det : infNFe.det ? [infNFe.det] : [];
  const items: ParsedNfeItem[] = detList.map((det: any, idx: number) => {
    const prod = det.prod || {};
    const imposto = det.imposto || {};

    // Extract ICMS CST
    let cstIcms: string | undefined;
    let icmsRate = 0;
    let icmsValue = 0;
    if (imposto.ICMS) {
      const icmsGroup = Object.values(imposto.ICMS)[0] as any;
      if (icmsGroup) {
        cstIcms = icmsGroup.CST !== undefined ? String(icmsGroup.CST) : icmsGroup.CSOSN !== undefined ? String(icmsGroup.CSOSN) : undefined;
        icmsRate = Number(icmsGroup.pICMS || 0);
        icmsValue = Number(icmsGroup.vICMS || 0);
      }
    }

    // IPI
    let ipiValue = 0;
    if (imposto.IPI?.IPITrib) {
      ipiValue = Number(imposto.IPI.IPITrib.vIPI || 0);
    }

    // PIS
    let pisValue = 0;
    if (imposto.PIS?.PISAliq) {
      pisValue = Number(imposto.PIS.PISAliq.vPIS || 0);
    }

    // COFINS
    let cofinsValue = 0;
    if (imposto.COFINS?.COFINSAliq) {
      cofinsValue = Number(imposto.COFINS.COFINSAliq.vCOFINS || 0);
    }

    const unitValue = Number(prod.vUnCom || 0);
    const totalProdValue = Number(prod.vProd || 0);
    const descValue = Number(prod.vDesc || 0);
    const netItemVal = Number(det.vItem || (totalProdValue - descValue));

    const inference = inferSuggestedDestination({
      description: String(prod.xProd || ''),
      ncm: String(prod.NCM || ''),
      cfop: String(prod.CFOP || ''),
      unit_value: unitValue,
    });

    return {
      item_index: Number(det['@_nItem'] || idx + 1),
      product_code: String(prod.cProd || ''),
      ean: prod.cEAN && prod.cEAN !== 'SEM GTIN' ? String(prod.cEAN) : undefined,
      description: String(prod.xProd || ''),
      ncm: String(prod.NCM || ''),
      cfop: String(prod.CFOP || ''),
      unit: normalizeUnit(String(prod.uCom || 'UN')),
      quantity: Number(prod.qCom || 1),
      unit_value: unitValue,
      total_value: totalProdValue,
      discount_value: descValue,
      net_item_value: netItemVal,
      cst_icms: cstIcms,
      icms_rate: icmsRate,
      icms_value: icmsValue,
      ipi_value: ipiValue,
      pis_value: pisValue,
      cofins_value: cofinsValue,
      tax_details: imposto,
      suggested_destination: inference.destination,
      extracted_serial_number: inference.serial_number,
      extracted_model: inference.model,
    };
  });

  // Totals
  const icmsTot = infNFe.total?.ICMSTot || {};
  const totals = {
    total_products: Number(icmsTot.vProd || 0),
    total_discount: Number(icmsTot.vDesc || 0),
    total_freight: Number(icmsTot.vFrete || 0),
    total_insurance: Number(icmsTot.vSeg || 0),
    total_other: Number(icmsTot.vOutro || 0),
    total_invoice: Number(icmsTot.vNF || 0),
    total_icms: Number(icmsTot.vICMS || 0),
    total_pis: Number(icmsTot.vPIS || 0),
    total_cofins: Number(icmsTot.vCOFINS || 0),
    total_ipi: Number(icmsTot.vIPI || 0),
  };

  // Duplicates / Installments
  const installments: ParsedNfeInstallment[] = [];
  if (infNFe.cobr?.dup) {
    const dupList = Array.isArray(infNFe.cobr.dup) ? infNFe.cobr.dup : [infNFe.cobr.dup];
    dupList.forEach((dup: any) => {
      if (dup) {
        installments.push({
          installment_number: String(dup.nDup || installments.length + 1),
          due_date: String(dup.dVenc || ''),
          amount: Number(dup.vDup || 0),
        });
      }
    });
  }

  // If no dup found, but total_invoice > 0, generate 1 default installment
  if (installments.length === 0 && totals.total_invoice > 0) {
    let defaultDueDate = ide.dhEmi || ide.dEmi || new Date().toISOString();
    defaultDueDate = defaultDueDate.split('T')[0];
    installments.push({
      installment_number: '1',
      due_date: defaultDueDate,
      amount: totals.total_invoice,
    });
  }

  return {
    access_key: accessKey,
    invoice_number: String(ide.nNF || ''),
    series: String(ide.serie || '1'),
    issue_date: ide.dhEmi || ide.dEmi || new Date().toISOString(),
    operation_type: 'entrada',
    nature_of_operation: String(ide.natOp || ''),
    issuer: {
      cnpj: String(emit.CNPJ || emit.CPF || ''),
      name: String(emit.xNome || ''),
      fantasy_name: emit.xFant ? String(emit.xFant) : undefined,
      ie: emit.IE ? String(emit.IE) : undefined,
      city: enderEmit.xMun ? String(enderEmit.xMun) : undefined,
      state: enderEmit.UF ? String(enderEmit.UF) : undefined,
      full_address: fullAddress,
    },
    recipient: {
      cnpj: String(dest.CNPJ || dest.CPF || ''),
      name: String(dest.xNome || ''),
      ie: dest.IE ? String(dest.IE) : undefined,
      email: dest.email ? String(dest.email) : undefined,
      city: dest.enderDest?.xMun ? String(dest.enderDest.xMun) : undefined,
      state: dest.enderDest?.UF ? String(dest.enderDest.UF) : undefined,
    },
    items,
    totals,
    installments,
    additional_info: infNFe.infAdic?.infCpl ? String(infNFe.infAdic.infCpl) : undefined,
  };
}
