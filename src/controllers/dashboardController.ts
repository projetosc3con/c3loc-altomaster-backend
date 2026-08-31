import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';

export const getDashboardData = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const userId = req.user?.id;
    const accessLevel = req.profile?.access_level || 'Usuário';

    // Dashboard Comercial
    if (accessLevel === 'Comercial') {
      return getComercialDashboard(req, res, supabase, userId!);
    }

    // Dashboard Administrativo (Administrador, Diretoria, Gerente)
    return getAdminDashboard(req, res, supabase);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

// ═══════════════════════════════════════════════
// DASHBOARD ADMINISTRATIVO / GERENCIAL
// ═══════════════════════════════════════════════
const getAdminDashboard = async (req: AuthRequest, res: Response, supabase: any) => {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    // ── 1. Window of last 6 months for bills ──
    const d6 = new Date(currentYear, currentMonth - 5, 1);
    const sixMonthsStart = `${d6.getFullYear()}-${String(d6.getMonth() + 1).padStart(2, '0')}-01`;
    const endOfMonth = new Date(currentYear, currentMonth + 1, 0); // last day
    const endOfMonthStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    const startOfMonth = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;

    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const startOfPrevMonth = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-01`;
    const endOfPrevMonth = new Date(prevYear, prevMonth + 1, 0);
    const endOfPrevMonthStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(endOfPrevMonth.getDate()).padStart(2, '0')}`;

    const { data: billsData } = await supabase
      .from('bills')
      .select('gross_value, net_value, type, due_date')
      .gte('due_date', sixMonthsStart)
      .lte('due_date', endOfMonthStr);

    const calcBalance = (list: any[]) =>
      (list || []).reduce((acc: number, b: any) => {
        const val = Number(b.net_value ?? b.gross_value ?? 0);
        return b.type === 'payable' ? acc - val : acc + val;
      }, 0);

    const currentMonthBills = (billsData || []).filter(
      (b: any) => b.due_date && b.due_date >= startOfMonth && b.due_date <= endOfMonthStr
    );
    const currentMonthTotal = calcBalance(currentMonthBills);

    const prevMonthBills = (billsData || []).filter(
      (b: any) => b.due_date && b.due_date >= startOfPrevMonth && b.due_date <= endOfPrevMonthStr
    );
    const prevMonthTotal = calcBalance(prevMonthBills);

    const variation = prevMonthTotal !== 0
      ? ((currentMonthTotal - prevMonthTotal) / Math.abs(prevMonthTotal)) * 100
      : currentMonthTotal !== 0 ? 100 : 0;

    // ── 2. Pending reconciliation count (bills) ──
    const { count: pendingReconciliationCount } = await supabase
      .from('bills')
      .select('*', { count: 'exact', head: true })
      .in('status', ['No prazo', 'Atrasado', 'Pendente']);

    // ── 3. Equipment with status "Locado" ──
    const { count: rentedEquipmentCount } = await supabase
      .from('equipments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'Locado');

    // ── 4. Service orders count ──
    const { count: serviceOrderCount } = await supabase
      .from('service_orders')
      .select('*', { count: 'exact', head: true });

    // ── 5. Balance last 6 months (for chart) ──
    const revenueByMonth: { month: string; label: string; total: number }[] = [];
    const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(currentYear, currentMonth - i, 1);
      const mYear = d.getFullYear();
      const mMonth = d.getMonth();
      const monthPrefix = `${mYear}-${String(mMonth + 1).padStart(2, '0')}`;

      const mBills = (billsData || []).filter(
        (b: any) => b.due_date && b.due_date.startsWith(monthPrefix)
      );

      revenueByMonth.push({
        month: monthPrefix,
        label: monthNames[mMonth],
        total: calcBalance(mBills),
      });
    }

    // ── 6. Fleet status ──
    const { data: allEquipments } = await supabase
      .from('equipments')
      .select('status');

    const fleetStatus = {
      disponivel: 0,
      locado: 0,
      manutencao: 0,
      inativo: 0,
      total: 0,
    };

    (allEquipments || []).forEach((eq: any) => {
      fleetStatus.total++;
      switch (eq.status) {
        case 'Disponível': fleetStatus.disponivel++; break;
        case 'Locado': fleetStatus.locado++; break;
        case 'Em Manutenção': fleetStatus.manutencao++; break;
        case 'Inativo': fleetStatus.inativo++; break;
      }
    });

    // ── 7. Recent invoices ──
    const { data: recentInvoices } = await supabase
      .from('rental_invoices')
      .select('id, client_name, equipment_name, asset_number, due_date, total_value, billing_status')
      .not('due_date', 'is', null)
      .order('due_date', { ascending: false })
      .limit(5);

    return res.json({
      type: 'admin',
      kpis: {
        currentMonthTotal,
        prevMonthTotal,
        variation: Math.round(variation * 10) / 10,
        pendingReconciliationCount: pendingReconciliationCount || 0,
        rentedEquipmentCount: rentedEquipmentCount || 0,
        serviceOrderCount: serviceOrderCount || 0,
      },
      revenueByMonth,
      fleetStatus,
      recentInvoices: recentInvoices || [],
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

// ═══════════════════════════════════════════════
// DASHBOARD COMERCIAL
// ═══════════════════════════════════════════════
const getComercialDashboard = async (req: AuthRequest, res: Response, supabase: any, userId: string) => {
  try {
    // ── 1. Tarefas do usuário (para calendário) ──
    const { data: tasks } = await supabase
      .from('crm_tasks')
      .select(`
        id, title, description, due_date, status, priority, 
        assigned_to, task_type_id, deal_id, lead_id, contact_id,
        created_by,
        type:crm_task_types(name)
      `)
      .eq('assigned_to', userId)
      .order('due_date', { ascending: true });

    // ── 2. Deals fechados (pipeline ativo) ──
    // Buscar pipeline ativo
    const { data: pipelines } = await supabase
      .from('crm_pipelines')
      .select('id')
      .eq('active', true)
      .limit(1);

    const activePipelineId = pipelines?.[0]?.id;

    let closedDealsData = {
      totalValue: 0,
      totalCount: 0,
      userValue: 0,
      userCount: 0,
      userPercentage: 0
    };

    if (activePipelineId) {
      // Estágios ganhos do pipeline
      const { data: wonStages } = await supabase
        .from('crm_pipeline_stages')
        .select('id')
        .eq('pipeline_id', activePipelineId)
        .eq('is_won', true);

      const wonStageIds = (wonStages || []).map((s: any) => s.id);

      if (wonStageIds.length > 0) {
        // Total de deals fechados (ganhos)
        const { data: allWonDeals } = await supabase
          .from('crm_deals')
          .select('id, value, owner_id')
          .eq('pipeline_id', activePipelineId)
          .in('stage_id', wonStageIds);

        const allWon = allWonDeals || [];
        closedDealsData.totalCount = allWon.length;
        closedDealsData.totalValue = allWon.reduce((acc: number, d: any) => acc + Number(d.value || 0), 0);

        // Deals do usuário logado
        const userWon = allWon.filter((d: any) => d.owner_id === userId);
        closedDealsData.userCount = userWon.length;
        closedDealsData.userValue = userWon.reduce((acc: number, d: any) => acc + Number(d.value || 0), 0);
        closedDealsData.userPercentage = closedDealsData.totalCount > 0
          ? Math.round((closedDealsData.userCount / closedDealsData.totalCount) * 100)
          : 0;
      }
    }

    // ── 3. Origem dos leads do usuário (para gráfico de pizza) ──
    const { data: userLeads } = await supabase
      .from('crm_leads')
      .select('source')
      .eq('owner_id', userId);

    const leadSources: Record<string, number> = {};
    (userLeads || []).forEach((lead: any) => {
      const src = lead.source || 'Não informado';
      leadSources[src] = (leadSources[src] || 0) + 1;
    });

    const leadSourcesArray = Object.entries(leadSources).map(([name, count]) => ({
      name,
      count
    }));

    // ── 4. Atividades do pipeline ativo ──
    const { data: activities } = await supabase
      .from('crm_deal_activities')
      .select(`
        id, activity_type, description, created_at,
        deal:crm_deals(title),
        performer:users_profiles!crm_deal_activities_performed_by_fkey(full_name, photo_url),
        stage_from:crm_pipeline_stages!crm_deal_activities_stage_from_id_fkey(name),
        stage_to:crm_pipeline_stages!crm_deal_activities_stage_to_id_fkey(name)
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    return res.json({
      type: 'comercial',
      tasks: tasks || [],
      closedDeals: closedDealsData,
      leadSources: leadSourcesArray,
      activities: activities || []
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
