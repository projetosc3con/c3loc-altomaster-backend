import { gerarPDF } from 'nfe-danfe-pdf';

/**
 * Renderiza o buffer do PDF do DANFE Clássico com Canhoto a partir do XML oficial (nfeProc)
 * com 100% de paridade visual em relação ao manual da SEFAZ (MOC Retrato).
 */
export async function generateClassicDanfePdfBuffer(xmlContent: string): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = await gerarPDF(xmlContent, { cancelada: false });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      doc.on('end', () => {
        const fullBuffer = Buffer.concat(chunks);
        resolve(fullBuffer);
      });

      doc.on('error', (err: any) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

