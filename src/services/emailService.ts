import axios, { AxiosInstance } from 'axios';

const RESEND_BASE_URL = 'https://api.resend.com';

interface BoletoEmailParams {
  to: string;
  clientName: string;
  companyName: string;
  totalValue: number;
  dueDate: string;
  invoiceUrl: string;
  bankSlipUrl?: string | null;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

function buildBoletoEmailTemplate(params: BoletoEmailParams, replyTo: string): string {
  const paymentLink = params.invoiceUrl || params.bankSlipUrl || '#';
  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#1f2937;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;">${params.companyName}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;color:#111827;font-size:16px;">Olá, ${params.clientName},</p>
                <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.5;">
                  Seu boleto de locação foi gerado. Confira os detalhes abaixo e efetue o pagamento até a data de vencimento.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;margin-bottom:24px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Valor</p>
                      <p style="margin:0 0 16px;color:#111827;font-size:20px;font-weight:bold;">${formatCurrency(params.totalValue)}</p>
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Vencimento</p>
                      <p style="margin:0;color:#111827;font-size:14px;">${formatDate(params.dueDate)}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="${paymentLink}" style="display:inline-block;background-color:#d97706;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;">
                        Ver boleto
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
                  Se você já efetuou o pagamento, desconsidere este e-mail.
                </p>
                <p style="margin:8px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
                  Este é um e-mail automático, não responda a esta mensagem. Em caso de dúvidas, entre em contato pelo e-mail ${replyTo}.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();
}

interface ContractEmailParams {
  to: string;
  contactName: string;
  companyName: string;
  contractNumber: string;
  equipmentDescription: string;
  totalValue: number;
  downloadUrl: string;
  pdfBase64?: string;
  pdfFilename?: string;
}

function buildContractEmailTemplate(params: ContractEmailParams, replyTo: string): string {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#1f2937;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;">${params.companyName}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;color:#111827;font-size:16px;">Olá, ${params.contactName},</p>
                <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.5;">
                  Sua proposta de locação foi gerada com sucesso. Segue em anexo o documento para sua análise e assinatura.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;margin-bottom:24px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Contrato Nº</p>
                      <p style="margin:0 0 16px;color:#111827;font-size:16px;font-weight:bold;">${params.contractNumber}</p>
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Equipamento</p>
                      <p style="margin:0 0 16px;color:#111827;font-size:14px;">${params.equipmentDescription}</p>
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Valor Total</p>
                      <p style="margin:0;color:#111827;font-size:20px;font-weight:bold;">${formatCurrency(params.totalValue)}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="${params.downloadUrl}" style="display:inline-block;background-color:#d97706;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;">
                        Baixar Proposta
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
                  Após análise, assine o documento e devolva ao nosso time comercial.
                </p>
                <p style="margin:8px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
                  Este é um e-mail automático, não responda a esta mensagem. Em caso de dúvidas, entre em contato pelo e-mail ${replyTo}.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();
}

interface SignedContractNotificationParams {
  to: string[];
  clientName: string;
  contractNumber: string;
  equipmentDescription: string;
  dealTitle: string;
  signedFileUrl: string;
}

function buildSignedContractNotificationTemplate(params: SignedContractNotificationParams): string {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#1f2937;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;">Notificação Interna - C3Loc</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;color:#111827;font-size:16px;">Olá Equipe de Logística,</p>
                <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.5;">
                  O contrato assinado para a negociação <strong>${params.dealTitle}</strong> foi anexado ao sistema.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;margin-bottom:24px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Cliente</p>
                      <p style="margin:0 0 16px;color:#111827;font-size:16px;font-weight:bold;">${params.clientName}</p>
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Contrato Nº</p>
                      <p style="margin:0 0 16px;color:#111827;font-size:14px;">${params.contractNumber}</p>
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Equipamento</p>
                      <p style="margin:0;color:#111827;font-size:14px;">${params.equipmentDescription}</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="${params.signedFileUrl}" style="display:inline-block;background-color:#d97706;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;">
                        Ver Contrato Assinado
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();
}

interface NfseEmailParams {
  to: string;
  clientName: string;
  companyName: string;
  equipmentDescription: string;
  nfseLink: string;
}

function buildNfseEmailTemplate(params: NfseEmailParams, replyTo: string): string {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#1f2937;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;">${params.companyName}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;color:#111827;font-size:16px;">Olá, ${params.clientName},</p>
                <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.5;">
                  Segue a nota fiscal referente à locação do equipamento <strong>${params.equipmentDescription}</strong>, emitida após a confirmação do pagamento.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="${params.nfseLink}" style="display:inline-block;background-color:#d97706;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;">
                        Ver Nota Fiscal
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
                  Este é um e-mail automático, não responda a esta mensagem. Em caso de dúvidas, entre em contato pelo e-mail ${replyTo}.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();
}

interface FaturaLocacaoEmailParams {
  to: string;
  clientName: string;
  companyName: string;
  equipmentDescription: string;
  faturaNumber?: string;
  totalValue: number;
  faturaLink?: string;
  pdfBase64?: string;
  pdfFilename?: string;
}

function buildFaturaLocacaoEmailTemplate(params: FaturaLocacaoEmailParams, replyTo: string): string {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:#1f2937;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;">${params.companyName}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;color:#111827;font-size:16px;">Olá, ${params.clientName},</p>
                <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.5;">
                  Segue a <strong>Fatura de Locação de Bens Móveis</strong> ${params.faturaNumber ? `(Nº ${params.faturaNumber})` : ''} referente ao equipamento <strong>${params.equipmentDescription}</strong>.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;margin-bottom:24px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px;color:#6b7280;font-size:12px;text-transform:uppercase;">Valor Total</p>
                      <p style="margin:0 0 8px;color:#111827;font-size:20px;font-weight:bold;">${formatCurrency(params.totalValue)}</p>
                    </td>
                  </tr>
                </table>
                ${params.faturaLink ? `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                  <tr>
                    <td align="center">
                      <a href="${params.faturaLink}" style="display:inline-block;background-color:#d97706;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 28px;border-radius:8px;">
                        Visualizar Fatura de Locação
                      </a>
                    </td>
                  </tr>
                </table>
                ` : ''}
                <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
                  Este é um e-mail automático, não responda a esta mensagem. Em caso de dúvidas, entre em contato pelo e-mail ${replyTo}.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();
}

// [STANDBY - RESEND] Notificações por e-mail via Resend temporariamente em standby.
// Defina RESEND_ENABLED=true no .env (ou altere esta constante) quando desejar reativar.
const RESEND_ENABLED = process.env.RESEND_ENABLED === 'true';

class EmailService {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: RESEND_BASE_URL,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async sendBoletoEmail(params: BoletoEmailParams): Promise<void> {
    if (!RESEND_ENABLED) {
      console.log('[emailService] [STANDBY] Envio de e-mail de boleto via Resend em standby (ignorado).');
      return;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY não configurada');

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'C3Loc <onboarding@resend.dev>';
    // Sem domínio verificado no Resend, o modo de teste só entrega para o
    // e-mail da própria conta — EMAIL_TEST_OVERRIDE redireciona todo envio
    // pra esse endereço em vez do e-mail real do cliente.
    const to = params.to || process.env.EMAIL_TEST_OVERRIDE;

    // altomaster.com.br (domínio verificado no Resend, usado em fromEmail) só
    // envia — não tem caixa de entrada configurada, então qualquer resposta
    // do cliente se perderia. reply_to redireciona a resposta pra uma caixa
    // que existe de fato.
    const replyTo = process.env.RESEND_REPLY_TO_EMAIL || 'victorhsltech@gmail.com';

    await this.http.post(
      '/emails',
      {
        from: fromEmail,
        to: [to],
        reply_to: replyTo,
        subject: `Boleto de locação - ${params.companyName}`,
        html: buildBoletoEmailTemplate(params, replyTo),
      },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
  }

  async sendContractEmail(params: ContractEmailParams): Promise<void> {
    if (!RESEND_ENABLED) {
      console.log('[emailService] [STANDBY] Envio de e-mail de contrato via Resend em standby (ignorado).');
      return;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY não configurada');

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'C3Loc <onboarding@resend.dev>';
    const to = params.to || process.env.EMAIL_TEST_OVERRIDE;
    const replyTo = process.env.RESEND_REPLY_TO_EMAIL || 'victorhsltech@gmail.com';

    const payload: any = {
      from: fromEmail,
      to: [to],
      reply_to: replyTo,
      subject: `Contrato de Locação - ${params.companyName}`,
      html: buildContractEmailTemplate(params, replyTo),
    };

    // Attach PDF if base64 content is provided
    if (params.pdfBase64 && params.pdfFilename) {
      payload.attachments = [{
        filename: params.pdfFilename,
        content: params.pdfBase64,
      }];
    }

    await this.http.post(
      '/emails',
      payload,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
  }

  async sendNfseEmail(params: NfseEmailParams): Promise<void> {
    if (!RESEND_ENABLED) {
      console.log('[emailService] [STANDBY] Envio de e-mail de NFS-e via Resend em standby (ignorado).');
      return;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY não configurada');

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'C3Loc <onboarding@resend.dev>';
    const to = params.to || process.env.EMAIL_TEST_OVERRIDE;
    const replyTo = process.env.RESEND_REPLY_TO_EMAIL || 'victorhsltech@gmail.com';

    await this.http.post(
      '/emails',
      {
        from: fromEmail,
        to: [to],
        reply_to: replyTo,
        subject: `Nota Fiscal de Locação - ${params.companyName}`,
        html: buildNfseEmailTemplate(params, replyTo),
      },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
  }

  async sendFaturaLocacaoEmail(params: FaturaLocacaoEmailParams): Promise<void> {
    if (!RESEND_ENABLED) {
      console.log('[emailService] [STANDBY] Envio de e-mail de fatura de locação via Resend em standby (ignorado).');
      return;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY não configurada');

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'C3Loc <onboarding@resend.dev>';
    const to = params.to || process.env.EMAIL_TEST_OVERRIDE;
    const replyTo = process.env.RESEND_REPLY_TO_EMAIL || 'victorhsltech@gmail.com';

    const payload: any = {
      from: fromEmail,
      to: [to],
      reply_to: replyTo,
      subject: `Fatura de Locação ${params.faturaNumber ? `Nº ${params.faturaNumber} ` : ''}- ${params.companyName}`,
      html: buildFaturaLocacaoEmailTemplate(params, replyTo),
    };

    if (params.pdfBase64 && params.pdfFilename) {
      payload.attachments = [{
        filename: params.pdfFilename,
        content: params.pdfBase64,
      }];
    }

    await this.http.post(
      '/emails',
      payload,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
  }

  async sendSignedContractNotification(params: SignedContractNotificationParams): Promise<void> {
    if (!RESEND_ENABLED) {
      console.log('[emailService] [STANDBY] Envio de notificação interna de contrato via Resend em standby (ignorado).');
      return;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY não configurada');

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'C3Loc <onboarding@resend.dev>';
    // Always use test override if set, otherwise use the provided list
    const to = params.to || process.env.EMAIL_TEST_OVERRIDE;
    const replyTo = process.env.RESEND_REPLY_TO_EMAIL || 'victorhsltech@gmail.com';

    if (to.length === 0) return;

    await this.http.post(
      '/emails',
      {
        from: fromEmail,
        to,
        reply_to: replyTo,
        subject: `Novo Contrato Assinado - ${params.dealTitle}`,
        html: buildSignedContractNotificationTemplate(params),
      },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
  }
}

export const emailService = new EmailService();
