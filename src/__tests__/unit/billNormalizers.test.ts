import { describe, it, expect } from 'vitest';
import { normalizeBill, normalizePendingPayment } from '../../utils/billNormalizers';

describe('normalizeBill', () => {
  it('mapeia um bill completo, com relações embutidas', () => {
    const row = {
      id: 'bill-1',
      type: 'receivable',
      status: 'Recebido',
      origin: 'ASAAS',
      gross_value: 1000,
      net_value: 990,
      fee_amount: 10,
      due_date: '2026-08-20',
      reconciled_at: '2026-08-21T00:00:00.000Z',
      client_id: 'client-1',
      client: { company_name: 'Cliente X' },
      counterparty_name: null,
      invoice: { invoice_number: 'FAT-01' },
      description: null,
      payment: { invoice_url: 'https://x/i', bank_slip_url: 'https://x/b' },
      bank_transaction_date: '2026-08-21',
    };

    const result = normalizeBill(row);

    expect(result).toMatchObject({
      source: 'bill',
      id: 'bill-1',
      client_name: 'Cliente X',
      invoice_number: 'FAT-01',
      invoice_url: 'https://x/i',
      bank_slip_url: 'https://x/b',
      is_reconciled: true,
      settled_date: '2026-08-21T00:00:00.000Z',
    });
  });

  it('usa null nos campos relacionados quando não há relação embutida', () => {
    const row = {
      id: 'bill-2',
      type: 'payable',
      status: 'Pendente',
      origin: 'MANUAL',
      gross_value: 500,
      net_value: 500,
      fee_amount: 0,
      due_date: '2026-08-20',
      reconciled_at: null,
      client_id: null,
      counterparty_name: 'Fornecedor Y',
      description: 'Aluguel de sala',
      bank_transaction_date: null,
    };

    const result = normalizeBill(row);

    expect(result.client_name).toBeNull();
    expect(result.invoice_number).toBeNull();
    expect(result.invoice_url).toBeNull();
    expect(result.bank_slip_url).toBeNull();
    expect(result.is_reconciled).toBe(false);
    expect(result.counterparty_name).toBe('Fornecedor Y');
  });

  it('mapeia NF-e com access_key do barcode ou snapshot e extrai número de fatura', () => {
    const row = {
      id: 'bill-nfe-1',
      type: 'payable',
      status: 'Pendente',
      origin: 'NFE',
      gross_value: 659.93,
      net_value: 659.93,
      fee_amount: 0,
      due_date: '2026-10-01',
      barcode: '51260913164401000129550010000285101639814554',
      bank_raw_snapshot: {
        access_key: '51260913164401000129550010000285101639814554',
        invoice_number: '28510',
        installment_number: 1,
        total_installments: 3,
        total_invoice: 1980,
      },
      counterparty_name: 'M K EMPILHADEIRAS',
    };

    const result = normalizeBill(row);

    expect(result.origin).toBe('NFE');
    expect(result.access_key).toBe('51260913164401000129550010000285101639814554');
    expect(result.invoice_number).toBe('NF-e 28510');
    expect(result.counterparty_name).toBe('M K EMPILHADEIRAS');
  });
});

describe('normalizePendingPayment', () => {
  it('calcula fee_amount a partir de value - net_value quando net_value existe', () => {
    const row = {
      id: 'pay-1',
      status: 'PENDING',
      value: 1003.49,
      net_value: 1000,
      due_date: '2026-08-25',
      payment_date: null,
      client_id: 'client-1',
      invoice: { client_name: 'Cliente X', invoice_number: 'FAT-01' },
      invoice_url: 'https://x/i',
      bank_slip_url: 'https://x/b',
    };

    const result = normalizePendingPayment(row);

    expect(result.source).toBe('payment');
    expect(result.type).toBe('receivable');
    expect(result.fee_amount).toBeCloseTo(3.49, 2);
    expect(result.is_reconciled).toBe(false);
  });

  it('fee_amount é null quando net_value ainda não está definido', () => {
    const row = {
      id: 'pay-2',
      status: 'PENDING',
      value: 1000,
      net_value: null,
      due_date: '2026-08-25',
      payment_date: null,
      client_id: 'client-1',
      invoice_url: null,
      bank_slip_url: null,
    };

    const result = normalizePendingPayment(row);

    expect(result.fee_amount).toBeNull();
    expect(result.client_name).toBeNull();
    expect(result.invoice_number).toBeNull();
  });
});
