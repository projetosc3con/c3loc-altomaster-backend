import { Request, Response, NextFunction } from 'express';

const DEFAULT_POWERBI_API_KEY = 'pbi_sec_altomaster_2026_c3loc_key';

export const validatePowerBiApiKey = (req: Request, res: Response, next: NextFunction) => {
  const configuredKey = process.env.POWERBI_API_KEY || DEFAULT_POWERBI_API_KEY;

  const headerKey =
    req.headers['x-api-key'] ||
    req.headers['apikey'] ||
    (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : null);

  const providedKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({
      error: 'Unauthorized: Chave de API estática do Power BI inválida ou não informada.',
      hint: 'Envie o header "x-api-key: SUA_CHAVE" ou "Authorization: Bearer SUA_CHAVE" na requisição.'
    });
  }

  next();
};
