import axios from 'axios';

export interface NormalizedCnpjData {
  valid: boolean;
  cnpj: string;
  company_name: string;
  trade_name?: string;
  phone?: string;
  email?: string;
  address_street?: string;
  address_number?: string;
  address_neighborhood?: string;
  address_complement?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  source?: 'opencnpj' | 'brasilapi' | 'receitaws' | 'offline_checksum';
  message?: string;
}

export const isValidCnpjChecksum = (cnpj: string): boolean => {
  const clean = cnpj.replace(/\D/g, '');
  if (clean.length !== 14) return false;
  if (/^(\d)\1+$/.test(clean)) return false;

  let size = clean.length - 2;
  let numbers = clean.substring(0, size);
  const digits = clean.substring(size);
  let sum = 0;
  let pos = size - 7;
  for (let i = size; i >= 1; i--) {
    sum += Number(numbers.charAt(size - i)) * pos--;
    if (pos < 2) pos = 9;
  }
  let result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (result !== Number(digits.charAt(0))) return false;

  size = size + 1;
  numbers = clean.substring(0, size);
  sum = 0;
  pos = size - 7;
  for (let i = size; i >= 1; i--) {
    sum += Number(numbers.charAt(size - i)) * pos--;
    if (pos < 2) pos = 9;
  }
  result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (result !== Number(digits.charAt(1))) return false;

  return true;
};

const formatCep = (rawCep: any): string => {
  const digits = String(rawCep || '').replace(/\D/g, '');
  if (digits.length === 8) {
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }
  return String(rawCep || '');
};

const formatPhone = (rawPhone: string, ddd?: string): string => {
  if (!rawPhone && !ddd) return '';
  const cleanPhone = String(rawPhone || '').replace(/\D/g, '');
  const cleanDdd = String(ddd || '').replace(/\D/g, '');

  if (cleanDdd && cleanPhone) {
    return `(${cleanDdd}) ${cleanPhone}`;
  }
  if (cleanPhone.length === 10) {
    return `(${cleanPhone.slice(0, 2)}) ${cleanPhone.slice(2, 6)}-${cleanPhone.slice(6)}`;
  }
  if (cleanPhone.length === 11) {
    return `(${cleanPhone.slice(0, 2)}) ${cleanPhone.slice(2, 7)}-${cleanPhone.slice(7)}`;
  }
  return rawPhone;
};

const buildAddressComplement = (parts: {
  street?: string;
  number?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zip?: string;
}) => {
  const items: string[] = [];
  if (parts.street) items.push(parts.street);
  if (parts.number) items.push(`Nº ${parts.number}`);
  if (parts.neighborhood) items.push(parts.neighborhood);
  if (parts.city || parts.state) {
    items.push(`${parts.city || ''} - ${parts.state || ''}`.trim().replace(/^-\s*|\s*-$/g, ''));
  }
  if (parts.zip) items.push(`CEP: ${parts.zip}`);
  return items.join(', ');
};

export class CnpjService {
  private static readonly TIMEOUT_MS = 4500;
  private static readonly USER_AGENT = 'C3Loc-ERP/1.0 (+https://altomaster.com.br)';

  /**
   * Consulta o CNPJ em múltiplos provedores em cascata (OpenCNPJ -> BrasilAPI -> ReceitaWS).
   * Se todos falharem mas o checksum for válido, retorna offline_checksum para não travar o usuário.
   */
  public async lookupCnpj(rawCnpj: string): Promise<NormalizedCnpjData> {
    const unmasked = (rawCnpj || '').replace(/\D/g, '');

    if (unmasked.length !== 14) {
      throw new Error('CNPJ incompleto (deve conter 14 dígitos).');
    }

    if (!isValidCnpjChecksum(unmasked)) {
      throw new Error('CNPJ inválido (dígitos verificadores incorretos).');
    }

    // 1. Tentar OpenCNPJ
    try {
      const response = await axios.get(`https://api.opencnpj.org/${unmasked}`, {
        timeout: CnpjService.TIMEOUT_MS,
        headers: { 'User-Agent': CnpjService.USER_AGENT }
      });
      if (response.status === 200 && response.data) {
        const d = response.data;
        const company_name = d.razao_social || d.razao_scoial || '';
        if (company_name || d.cnpj) {
          const tipo = (d.tipo_logradouro || '').trim();
          const logr = (d.logradouro || '').trim();
          const street = tipo && logr ? `${tipo} ${logr}` : logr || tipo;
          const num = d.numero || '';
          const neighborhood = d.bairro || '';
          const city = d.municipio || '';
          const state = d.uf || '';
          const zip = formatCep(d.cep);
          const tel = d.telefones?.[0];
          const phone = tel ? formatPhone(tel.numero, tel.ddd) : '';

          return {
            valid: true,
            cnpj: unmasked,
            company_name,
            trade_name: d.nome_fantasia || '',
            phone,
            email: d.email || '',
            address_street: street,
            address_number: num,
            address_neighborhood: neighborhood,
            address_city: city,
            address_state: state,
            address_zip: zip,
            address_complement: buildAddressComplement({
              street,
              number: num,
              neighborhood,
              city,
              state,
              zip
            }),
            source: 'opencnpj'
          };
        }
      }
    } catch (err: any) {
      console.warn(`[CnpjService] OpenCNPJ falhou para ${unmasked} (${err.message}). Tentando BrasilAPI...`);
    }

    // 2. Tentar BrasilAPI
    try {
      const response = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${unmasked}`, {
        timeout: CnpjService.TIMEOUT_MS,
        headers: { 'User-Agent': CnpjService.USER_AGENT }
      });
      if (response.status === 200 && response.data) {
        const d = response.data;
        const company_name = d.razao_social || '';
        if (company_name || d.cnpj) {
          const street = (d.logradouro || '').trim();
          const num = d.numero || '';
          const neighborhood = d.bairro || '';
          const city = d.municipio || '';
          const state = d.uf || '';
          const zip = formatCep(d.cep);
          const phone = d.ddd_telefone_1 ? formatPhone(d.ddd_telefone_1) : '';

          return {
            valid: true,
            cnpj: unmasked,
            company_name,
            trade_name: d.nome_fantasia || '',
            phone,
            email: d.email || '',
            address_street: street,
            address_number: num,
            address_neighborhood: neighborhood,
            address_city: city,
            address_state: state,
            address_zip: zip,
            address_complement: buildAddressComplement({
              street,
              number: num,
              neighborhood,
              city,
              state,
              zip
            }),
            source: 'brasilapi'
          };
        }
      }
    } catch (err: any) {
      console.warn(`[CnpjService] BrasilAPI falhou para ${unmasked} (${err.message}). Tentando ReceitaWS...`);
    }

    // 3. Tentar ReceitaWS
    try {
      const response = await axios.get(`https://receitaws.com.br/v1/cnpj/${unmasked}`, {
        timeout: CnpjService.TIMEOUT_MS,
        headers: { 'User-Agent': CnpjService.USER_AGENT }
      });
      if (response.status === 200 && response.data && response.data.status !== 'ERROR') {
        const d = response.data;
        const company_name = d.nome || '';
        if (company_name) {
          const street = (d.logradouro || '').trim();
          const num = d.numero || '';
          const neighborhood = d.bairro || '';
          const city = d.municipio || '';
          const state = d.uf || '';
          const zip = formatCep(d.cep);
          const phone = d.telefone ? formatPhone(d.telefone) : '';

          return {
            valid: true,
            cnpj: unmasked,
            company_name,
            trade_name: d.fantasia || '',
            phone,
            email: d.email || '',
            address_street: street,
            address_number: num,
            address_neighborhood: neighborhood,
            address_city: city,
            address_state: state,
            address_zip: zip,
            address_complement: buildAddressComplement({
              street,
              number: num,
              neighborhood,
              city,
              state,
              zip
            }),
            source: 'receitaws'
          };
        }
      }
    } catch (err: any) {
      console.warn(`[CnpjService] ReceitaWS falhou para ${unmasked} (${err.message}).`);
    }

    // Fallback: Checksum válido, mas todos os provedores online falharam
    return {
      valid: true,
      cnpj: unmasked,
      company_name: '',
      source: 'offline_checksum',
      message: 'CNPJ com dígito verificador válido, porém os servidores da Receita Federal estão temporariamente instáveis. Por favor preencha os dados cadastrais manualmente.'
    };
  }
}

export const cnpjService = new CnpjService();

