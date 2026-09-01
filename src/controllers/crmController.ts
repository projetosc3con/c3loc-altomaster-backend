import { Response } from 'express';
import axios from 'axios';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';
import { emailService } from '../services/emailService';
// Pipelines
export const getPipelines = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data: pipelines, error: pipelinesError } = await supabase
      .from('crm_pipelines')
      .select('*')
      .order('created_at', { ascending: true });

    if (pipelinesError) throw pipelinesError;

    const { data: stages, error: stagesError } = await supabase
      .from('crm_pipeline_stages')
      .select('*')
      .order('position', { ascending: true });

    if (stagesError) throw stagesError;

    // For active deals, we would query crm_deals, but let's just return 0 for now
    const pipelinesWithDetails = pipelines.map(p => ({
      ...p,
      stages: stages.filter(s => s.pipeline_id === p.id).length,
      activeDeals: 0,
      stageList: stages.filter(s => s.pipeline_id === p.id)
    }));

    res.json(pipelinesWithDetails);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getTaskTypes = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('crm_task_types')
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createPipeline = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { name, description, stages } = req.body;

    const { data: pipeline, error: pipelineError } = await supabase
      .from('crm_pipelines')
      .insert([{ name, description, active: true }])
      .select()
      .single();

    if (pipelineError) throw pipelineError;

    if (stages && stages.length > 0) {
      const stagesToInsert = stages.map((s: any, index: number) => ({
        pipeline_id: pipeline.id,
        name: s.name,
        position: index + 1,
        is_won: s.isWon || s.is_won || false,
        is_lost: s.isLost || s.is_lost || false,
        probability_pct: s.probability || s.probability_pct || 0
      }));

      const { error: stagesError } = await supabase
        .from('crm_pipeline_stages')
        .insert(stagesToInsert);

      if (stagesError) throw stagesError;
    }

    res.status(201).json(pipeline);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updatePipeline = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;
    const { name, description, active, stages } = req.body;

    const { data: pipeline, error: pipelineError } = await supabase
      .from('crm_pipelines')
      .update({ name, description, active })
      .eq('id', id)
      .select()
      .single();

    if (pipelineError) throw pipelineError;

    if (stages) {
      // For simplicity, delete old stages and insert new ones
      const { error: deleteError } = await supabase
        .from('crm_pipeline_stages')
        .delete()
        .eq('pipeline_id', id);

      if (deleteError) throw deleteError;

      if (stages.length > 0) {
        const stagesToInsert = stages.map((s: any, index: number) => ({
          pipeline_id: id,
          name: s.name,
          position: index + 1,
          is_won: s.isWon || s.is_won || false,
          is_lost: s.isLost || s.is_lost || false,
          probability_pct: s.probability || s.probability_pct || 0
        }));

        const { error: stagesError } = await supabase
          .from('crm_pipeline_stages')
          .insert(stagesToInsert);

        if (stagesError) throw stagesError;
      }
    }

    res.json(pipeline);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const deletePipeline = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    // First delete stages (cascade if configured, but good to be explicit)
    await supabase.from('crm_pipeline_stages').delete().eq('pipeline_id', id);

    const { error } = await supabase
      .from('crm_pipelines')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

// Leads
export const getLeads = async (req: AuthRequest, res: Response) => {
  try {
    // Usando supabaseAdmin para bypass de RLS, assim perfis 'Comercial' podem VER todos os leads
    const { data, error } = await supabaseAdmin
      .from('crm_leads')
      .select(`
        *,
        owner:users_profiles!owner_id(full_name)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Flatten owner name
    const leads = data.map(lead => ({
      ...lead,
      owner_name: lead.owner?.full_name
    }));

    res.json(leads);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createLead = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { contacts, ...leadData } = req.body;

    // Insert lead
    const { data: lead, error: leadError } = await supabase
      .from('crm_leads')
      .insert([leadData])
      .select()
      .single();

    if (leadError) throw leadError;

    // Insert contacts if provided
    if (contacts && contacts.length > 0) {
      const contactsToInsert = contacts.map((c: any) => ({
        ...c,
        lead_id: lead.id
      }));

      const { error: contactsError } = await supabase
        .from('crm_contacts')
        .insert(contactsToInsert);

      if (contactsError) throw contactsError;
    }

    res.status(201).json(lead);
  } catch (error: any) {
    console.error('[crmController] Erro em createLead:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

export const updateLead = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;
    const { contacts, owner, owner_name, ...leadData } = req.body;

    // Verificar propriedade
    const { data: existingLead, error: existingLeadError } = await supabase
      .from('crm_leads')
      .select('owner_id')
      .eq('id', id)
      .single();

    if (existingLeadError) throw existingLeadError;

    if (req.profile?.access_level === 'Comercial' && existingLead.owner_id !== req.user?.id) {
      return res.status(403).json({ error: 'Acesso negado. Você só pode editar leads que pertencem a você.' });
    }

    const { data: lead, error: leadError } = await supabase
      .from('crm_leads')
      .update(leadData)
      .eq('id', id)
      .select()
      .single();

    if (leadError) throw leadError;

    if (contacts) {
      // Simplesmente apagamos e reinserimos os contatos
      await supabase.from('crm_contacts').delete().eq('lead_id', id);

      if (contacts.length > 0) {
        const contactsToInsert = contacts.map((c: any) => {
          const { id: contactId, created_at, lead_id, ...contactData } = c; // remove campos que não devem ser inseridos
          return {
            ...contactData,
            lead_id: lead.id
          };
        });
        const { error: contactsError } = await supabase
          .from('crm_contacts')
          .insert(contactsToInsert);

        if (contactsError) throw contactsError;
      }
    }

    res.json(lead);
  } catch (error: any) {
    console.error('[crmController] Erro em updateLead:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

export const deleteLead = async (req: AuthRequest, res: Response) => {
  try {
    // Verificar permissão - apenas ADM ou Gerente podem excluir leads completamente
    if (req.profile?.access_level !== 'Administrador' && req.profile?.access_level !== 'Gerente') {
      return res.status(403).json({ error: 'Acesso negado. Você não tem permissão para excluir leads.' });
    }

    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    // Supabase will handle cascade delete if configured, or we can do it manually.
    // Based on create/updateLead, contacts are related to leads.
    await supabase.from('crm_contacts').delete().eq('lead_id', id);

    const { error } = await supabase
      .from('crm_leads')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.status(204).send();
  } catch (error: any) {
    console.error('[crmController] Erro em deleteLead:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor' });
  }
};

export const getLeadContacts = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    const { data, error } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em getLeadContacts:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

export const getAllContacts = async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crm_contacts')
      .select(`
        *,
        lead:crm_leads(company_name),
        client:clients(company_name)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const formattedContacts = data.map(contact => ({
      ...contact,
      company_name: contact.client?.company_name || contact.lead?.company_name || 'Sem vínculo',
      contact_type: contact.client_id ? 'client' : 'lead'
    }));

    res.json(formattedContacts);
  } catch (error: any) {
    console.error('[crmController] Erro em getAllContacts:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

export const createContact = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('crm_contacts')
      .insert([req.body])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em createContact:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

export const updateContact = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;
    const { data, error } = await supabase
      .from('crm_contacts')
      .update(req.body)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em updateContact:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

export const deleteContact = async (req: AuthRequest, res: Response) => {
  try {
    // Check permission - only full access users can delete
    if (req.profile?.access_level !== 'Administrador' && req.profile?.access_level !== 'Gestor') {
      return res.status(403).json({ error: 'Acesso negado. Você não tem permissão para excluir contatos.' });
    }

    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;
    const { error } = await supabase
      .from('crm_contacts')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.status(204).send();
  } catch (error: any) {
    console.error('[crmController] Erro em deleteContact:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

export const convertLead = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    // 1. Buscar o lead atual
    const { data: lead, error: fetchError } = await supabase
      .from('crm_leads')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (req.profile?.access_level === 'Comercial' && lead.owner_id !== req.user?.id) {
      return res.status(403).json({ error: 'Acesso negado. Você só pode converter leads que pertencem a você.' });
    }

    if (lead.status === 'Convertido') {
      return res.status(400).json({ error: 'Lead já foi convertido.' });
    }

    // 2. Buscar dados adicionais no opencnpj e extrair nota/score
    const rawScore = req.body.average_score ?? (req.body.score != null ? req.body.score / 200 : null);
    const averageScore = rawScore != null ? Number(Number(rawScore).toFixed(1)) : 0;

    let clientData: any = {
      company_name: lead.company_name,
      cnpj: lead.cnpj || '',
      average_score: averageScore,
      active: true
    };

    if (lead.cnpj) {
      const unmaskedCnpj = lead.cnpj.replace(/\D/g, '');
      if (unmaskedCnpj.length === 14) {
        try {
          const response = await axios.get(`https://api.opencnpj.org/${unmaskedCnpj}`);
          if (response.status === 200) {
            const data = response.data;

            const tipo_logradouro = data.tipo_logradouro || '';
            const logradouro = data.logradouro || '';
            const numero = data.numero || '';
            const bairro = data.bairro || '';
            const municipio = data.municipio || '';
            const uf = data.uf || '';
            const cepStr = (data.cep || '').replace(/\D/g, '');
            const cep_formatado = cepStr.length === 8 ? `${cepStr.slice(0, 5)}-${cepStr.slice(5)}` : data.cep || '';
            const address_street = `${tipo_logradouro} ${logradouro}`.trim();
            
            // Construir complemento apenas com o que existe
            const address_parts = [];
            if (address_street) address_parts.push(address_street);
            if (numero) address_parts.push(`Nº ${numero}`);
            if (bairro) address_parts.push(bairro);
            if (municipio) address_parts.push(municipio);
            if (uf) address_parts.push(uf);
            if (cep_formatado) address_parts.push(`CEP: ${cep_formatado}`);

            clientData = {
              ...clientData,
              company_name: data.razao_social || data.razao_scoial || lead.company_name,
              address_street,
              address_number: numero,
              address_complement: address_parts.join(', '),
              address_city: municipio,
              address_state: uf,
              address_zip: cep_formatado,
              email: data.email || '',
              phone: data.telefones?.[0] ? `(${data.telefones[0].ddd}) ${data.telefones[0].numero}` : ''
            };
          }
        } catch (err) {
          console.error('[crmController] Erro ao buscar CNPJ (opencnpj):', err);
        }
      }
    }

    // 3. Inserir ou atualizar na tabela clients
    let newClient: any = null;
    if (clientData.cnpj) {
      const { data: existingClient } = await supabase
        .from('clients')
        .select('*')
        .eq('cnpj', clientData.cnpj)
        .maybeSingle();

      if (existingClient) {
        const { data: updatedClient, error: updateError } = await supabase
          .from('clients')
          .update(clientData)
          .eq('id', existingClient.id)
          .select()
          .single();
        if (updateError) throw updateError;
        newClient = updatedClient;
      }
    }

    if (!newClient) {
      const { data: insertedClient, error: clientError } = await supabase
        .from('clients')
        .insert([clientData])
        .select()
        .single();
      if (clientError) throw clientError;
      newClient = insertedClient;
    }

    // 4. Migrar contatos (crm_contacts -> vinculá-los ao client_id)
    await supabase
      .from('crm_contacts')
      .update({ client_id: newClient.id })
      .eq('lead_id', id);

    // 4b. Relinkar negociações que apontavam pro lead convertido — sem isso
    // o deal continua "vinculado a Lead" mesmo depois da conversão, e a
    // triagem/faturamento falha mais adiante por falta de client_id.
    await supabase
      .from('crm_deals')
      .update({ client_id: newClient.id, lead_id: null })
      .eq('lead_id', id);

    // 5. Atualizar status do lead
    const { data: updatedLead, error: updateLeadError } = await supabase
      .from('crm_leads')
      .update({
        status: 'Convertido',
        converted_at: new Date().toISOString(),
        converted_client_id: newClient.id
      })
      .eq('id', id)
      .select()
      .single();

    if (updateLeadError) throw updateLeadError;

    res.json({ client: newClient, lead: updatedLead });
  } catch (error: any) {
    console.error('[crmController] Erro em convertLead:', error);
    res.status(500).json({ error: error.message || 'Erro interno do servidor', details: error });
  }
};

// Deals
export const getDeals = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('crm_deals')
      .select('*, lead:crm_leads(company_name), client:clients(company_name), owner:users_profiles!owner_id(full_name, photo_url)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em getDeals:', error);
    res.status(500).json({ error: error.message });
  }
};

export const createDeal = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const dealData = { ...req.body };

    if (!dealData.owner_id) {
      dealData.owner_id = req.user?.id;
    }

    // Clean empty relationships
    if (!dealData.lead_id) dealData.lead_id = null;
    if (!dealData.client_id) dealData.client_id = null;

    const { data: deal, error } = await supabase
      .from('crm_deals')
      .insert([dealData])
      .select()
      .single();

    if (error) throw error;

    // Log initial stage
    if (deal.stage_id) {
      await supabase.from('crm_deal_activities').insert([{
        deal_id: deal.id,
        activity_type: 'stage_change',
        description: 'Negociação iniciada',
        stage_to_id: deal.stage_id,
        performed_by: req.user?.id
      }]);
    }

    res.status(201).json(deal);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateDeal = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;
    const dealData = { ...req.body };

    // Check if stage is being changed
    let oldStageId = null;
    let targetStageInfo: { is_won?: boolean; is_lost?: boolean } | null = null;

    if (dealData.stage_id) {
      const { data: currentDeal } = await supabase
        .from('crm_deals')
        .select('stage_id')
        .eq('id', id)
        .single();
      
      oldStageId = currentDeal?.stage_id;

      // Fetch target stage flags
      const { data: targetStage } = await supabase
        .from('crm_pipeline_stages')
        .select('is_won, is_lost')
        .eq('id', dealData.stage_id)
        .single();

      targetStageInfo = targetStage;

      if (targetStage) {
        if (targetStage.is_won || targetStage.is_lost) {
          // Stage is terminal → set closed_at
          dealData.closed_at = new Date().toISOString();
        } else {
          // Stage is regular → reset closed_at and lost_reason
          dealData.closed_at = null;
          dealData.lost_reason = null;
        }
      }
    }

    const { data: updatedDeal, error } = await supabase
      .from('crm_deals')
      .update(dealData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // If stage changed, log it
    if (dealData.stage_id && dealData.stage_id !== oldStageId) {
      await supabase.from('crm_deal_activities').insert([{
        deal_id: id,
        activity_type: 'stage_change',
        description: 'Alteração de etapa',
        stage_from_id: oldStageId,
        stage_to_id: dealData.stage_id,
        performed_by: req.user?.id
      }]);
    }

    // Return enriched response with stage flags for frontend
    res.json({
      ...updatedDeal,
      _stageInfo: targetStageInfo || null
    });
  } catch (error: any) {
    console.error('[crmController] Erro em updateDeal:', error);
    res.status(500).json({ error: error.message });
  }
};

export const deleteDeal = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    const { error } = await supabase
      .from('crm_deals')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Negociação excluída com sucesso' });
  } catch (error: any) {
    console.error('[crmController] Erro em deleteDeal:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getDealActivities = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('crm_deal_activities')
      .select(`
        *,
        deal:crm_deals(title),
        performer:users_profiles!performed_by(full_name, photo_url),
        stage_from:crm_pipeline_stages!stage_from_id(name),
        stage_to:crm_pipeline_stages!stage_to_id(name)
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em getDealActivities:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getTasks = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('crm_tasks')
      .select(`
        *,
        type:crm_task_types(name),
        deal:crm_deals(title),
        assignee:users_profiles!assigned_to(full_name, photo_url)
      `)
      .order('due_date', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em getTasks:', error);
    res.status(500).json({ error: error.message });
  }
};


export const createTask = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const taskData = { 
      ...req.body,
      created_by: req.user?.id 
    };

    const { data, error } = await supabase
      .from('crm_tasks')
      .insert([taskData])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em createTask:', error);
    res.status(500).json({ error: error.message });
  }
};

export const updateTask = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;
    const updateData = { 
      ...req.body,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('crm_tasks')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('[crmController] Erro em updateTask:', error);
    res.status(500).json({ error: error.message });
  }
};

export const deleteTask = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { id } = req.params;

    // Se for Comercial, verificar se ele criou a tarefa
    if (req.profile?.access_level === 'Comercial') {
      const { data: task, error: fetchError } = await supabase
        .from('crm_tasks')
        .select('created_by')
        .eq('id', id)
        .single();

      if (fetchError) throw fetchError;

      if (task.created_by !== req.user?.id) {
        return res.status(403).json({ error: 'Acesso negado. Você só pode excluir tarefas criadas por você.' });
      }
    }

    const { error } = await supabase
      .from('crm_tasks')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.status(204).send();
  } catch (error: any) {
    console.error('[crmController] Erro em deleteTask:', error);
    res.status(500).json({ error: error.message });
  }
};

export const checkCnpj = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { cnpj } = req.params;
    const unmasked = (cnpj as string).replace(/\D/g, '');
    const masked = unmasked.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

    if (unmasked.length < 14) {
      return res.json({ exists: false });
    }

    // Buscar em leads
    const { data: lead } = await supabase
      .from('crm_leads')
      .select('id, company_name')
      .or(`cnpj.eq.${unmasked},cnpj.eq.${masked}`)
      .limit(1);

    if (lead && lead.length > 0) {
      return res.json({ exists: true, type: 'lead', name: lead[0].company_name });
    }

    // Buscar em clientes
    const { data: client } = await supabase
      .from('clients')
      .select('id, company_name')
      .or(`cnpj.eq.${unmasked},cnpj.eq.${masked}`)
      .limit(1);

    if (client && client.length > 0) {
      return res.json({ exists: true, type: 'client', name: client[0].company_name });
    }

    res.json({ exists: false });
  } catch (error: any) {
    console.error('[crmController] Erro em checkCnpj:', error);
    res.status(500).json({ error: error.message });
  }
};

// --- CONTRACTS ---
export const getContractForm = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const dealId = req.params.id;

    const { data: form, error } = await supabase
      .from('crm_deal_contract_forms')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (form) {
      return res.json(form);
    }

    // Se não tem form na tabela, tenta buscar do último contrato gerado (snapshot)
    const { data: lastContract } = await supabase
      .from('crm_deal_contracts')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastContract?.snapshot) {
      const s = lastContract.snapshot;
      return res.json({
        deal_id: dealId,
        contract_date: s.contract_date || new Date().toISOString().split('T')[0],
        locatario_company_name: s.locatario?.company_name || '',
        locatario_cnpj: s.locatario?.cnpj || '',
        locatario_state_registration: s.locatario?.state_registration || '',
        locatario_address_full: s.locatario?.address_full || '',
        equipment_description: s.equipment?.description || '',
        equipment_model: s.equipment?.model || '',
        contract_duration_days: s.contract_duration_days || 0,
        period_start: s.period_start || '',
        period_end: s.period_end || '',
        cost_rental: s.costs?.rental || 0,
        cost_insurance: s.costs?.insurance || 0,
        cost_freight: s.costs?.freight || 0,
        cost_rcd: s.costs?.rcd || 0,
        cost_third_party: s.costs?.third_party || 0,
        cost_training: s.costs?.training || 0,
        cost_total: s.costs?.total || 0,
        billing_interval_days: s.billing_interval_days || 28,
        work_site: s.work_site || '',
        site_contact_name: s.site_contact_name || '',
        site_contact_phone: s.site_contact_phone || '',
        notes: s.notes || '',
        form_status: 'Pronto para Gerar'
      });
    }

    // Se não tem form, preenche com os dados do deal e cliente
    const { data: deal } = await supabase
      .from('crm_deals')
      .select('*, leads:crm_leads(company_name, cnpj), clients(company_name, cnpj, state_subscription, address_street, address_number, address_city, address_state, contact_name, phone)')
      .eq('id', dealId)
      .single();
    if (!deal) return res.status(404).json({ error: 'Deal não encontrado' });

    const entity = deal.clients || deal.leads || {};
    
    res.json({
      deal_id: dealId,
      contract_date: new Date().toISOString().split('T')[0],
      locatario_company_name: entity.company_name || '',
      locatario_cnpj: entity.cnpj || '',
      locatario_state_registration: entity.state_registration || entity.state_subscription || '',
      locatario_address_full: entity.address_full || (entity.address_street ? `${entity.address_street}, ${entity.address_number} - ${entity.address_city}/${entity.address_state}` : ''),
      equipment_description: '',
      equipment_model: '',
      contract_duration_days: 0,
      period_start: deal.expected_close_date ? new Date(deal.expected_close_date).toISOString().split('T')[0] : '',
      period_end: '',
      cost_rental: Number(deal.value) || 0,
      cost_insurance: 0,
      cost_freight: 0,
      cost_rcd: 0,
      cost_third_party: 0,
      cost_training: 0,
      cost_total: Number(deal.value) || 0,
      billing_interval_days: 28,
      work_site: '',
      site_contact_name: entity.contact_name || '',
      site_contact_phone: entity.phone || '',
      notes: '',
      form_status: 'Rascunho'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

const buildContractSnapshot = async (form: any, contractNumber: string) => {
  const { data: settings } = await supabaseAdmin.from('erp_company_settings').select('*').eq('active', true).single();
  return {
    contract_number: contractNumber,
    contract_date: form.contract_date,
    locador: settings ? {
      company_name: settings.company_name,
      cnpj: settings.cnpj,
      state_registration: settings.state_registration,
      address_full: settings.address_full,
      logo_url: settings.logo_url,
      bank_name: settings.bank_name,
      bank_code: settings.bank_code,
      bank_agency: settings.bank_agency,
      bank_account: settings.bank_account,
      bank_pix_key: settings.bank_pix_key
    } : {},
    locatario: {
      company_name: form.locatario_company_name,
      cnpj: form.locatario_cnpj,
      state_registration: form.locatario_state_registration,
      address_full: form.locatario_address_full
    },
    equipment: {
      description: form.equipment_description,
      model: form.equipment_model,
      items: form.equipments || []
    },
    contract_duration_days: form.contract_duration_days,
    period_start: form.period_start,
    period_end: form.period_end,
    costs: {
      rental: form.cost_rental,
      insurance: form.cost_insurance,
      freight: form.cost_freight,
      rcd: form.cost_rcd,
      third_party: form.cost_third_party,
      training: form.cost_training,
      total: form.cost_total
    },
    billing_interval_days: form.billing_interval_days,
    work_site: form.work_site,
    site_contact_name: form.site_contact_name,
    site_contact_phone: form.site_contact_phone,
    clauses: settings?.contract_clauses || {}
  };
};

export const saveContractForm = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const dealId = req.params.id;
    const body = req.body;
    
    // Extract equipments if sent by frontend
    const equipments = body.equipments;
    delete body.equipments;

    // Sanitize body
    delete body.id;
    delete body.created_at;
    delete body.updated_at;
    delete body.created_by;
    
    body.deal_id = dealId;
    body.updated_by = req.user?.id;

    // Sanitize dates
    if (!body.contract_date) body.contract_date = new Date().toISOString().split('T')[0];
    if (body.period_start === '') body.period_start = null;
    if (body.period_end === '') body.period_end = null;

    // Check if there is an existing active contract
    const { data: existingContract } = await supabase
      .from('crm_deal_contracts')
      .select('*')
      .eq('deal_id', dealId)
      .neq('status', 'Cancelado')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // If a contract already exists and user is saving as ready, keep form_status as 'PDF Gerado'
    if (existingContract && body.form_status === 'Pronto para Gerar') {
      body.form_status = 'PDF Gerado';
    }

    const { data: existingForm } = await supabase.from('crm_deal_contract_forms').select('id').eq('deal_id', dealId).maybeSingle();

    let savedForm: any;
    if (existingForm) {
      body.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from('crm_deal_contract_forms').update(body).eq('id', existingForm.id).select().single();
      if (error) throw error;
      savedForm = data;
    } else {
      body.created_by = req.user?.id;
      const { data, error } = await supabase.from('crm_deal_contract_forms').insert(body).select().single();
      if (error) throw error;
      savedForm = data;
      
      await supabase.from('crm_deals').update({ contract_form_id: data.id }).eq('id', dealId);
    }

    if (equipments) {
      savedForm.equipments = equipments;
    }

    // If an existing contract already exists, update its snapshot in-place (preserving the contract number!)
    if (existingContract) {
      const updatedSnapshot = await buildContractSnapshot(savedForm, existingContract.contract_number);
      await supabase
        .from('crm_deal_contracts')
        .update({
          snapshot: updatedSnapshot,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingContract.id);
    }

    res.json(savedForm);
  } catch (error: any) {
    console.error('Error saving contract form:', error);
    res.status(500).json({ error: error.message });
  }
};

export const generateContractRecord = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const dealId = req.params.id;

    const { data: form, error: formError } = await supabase.from('crm_deal_contract_forms').select('*').eq('deal_id', dealId).single();
    if (formError || !form) throw new Error('Formulário não encontrado');
    if (form.form_status === 'Rascunho') throw new Error('Preencha os campos obrigatórios');

    // Check if an existing active contract already exists for this deal
    const { data: existingContract } = await supabase
      .from('crm_deal_contracts')
      .select('*')
      .eq('deal_id', dealId)
      .neq('status', 'Cancelado')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let contractNumber: string;
    let record: any;
    let snapshot: any;

    if (existingContract) {
      // REUSE EXISTING CONTRACT NUMBER AND UPDATE THE RECORD (EDIT IN-PLACE)
      contractNumber = existingContract.contract_number;
      snapshot = await buildContractSnapshot(form, contractNumber);

      const { data: updatedRecord, error: updateError } = await supabase
        .from('crm_deal_contracts')
        .update({
          snapshot,
          status: existingContract.status === 'Assinado' ? 'Assinado' : 'Gerado',
          generated_by: req.user?.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingContract.id)
        .select()
        .single();

      if (updateError) throw updateError;
      record = updatedRecord;
    } else {
      // NO EXISTING CONTRACT (FIRST GENERATION OR PREVIOUS CONTRACT DELETED) -> GENERATE NEW NUMBER
      const { data: nextNum } = await supabase.rpc('get_next_contract_number');
      contractNumber = nextNum;
      snapshot = await buildContractSnapshot(form, contractNumber);

      const { data: newRecord, error: recordError } = await supabase
        .from('crm_deal_contracts')
        .insert({
          deal_id: dealId,
          contract_form_id: form.id,
          contract_number: contractNumber,
          version: 1,
          status: 'Gerado',
          generated_by: req.user?.id,
          snapshot
        })
        .select()
        .single();

      if (recordError) throw recordError;
      record = newRecord;

      await supabase
        .from('crm_deals')
        .update({ active_contract_id: record.id })
        .eq('id', dealId);
    }

    await supabase.from('crm_deal_contract_forms').update({ form_status: 'PDF Gerado', updated_by: req.user?.id }).eq('id', form.id);

    res.json({ record, snapshot });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getContracts = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase.from('crm_deal_contracts').select('*').eq('deal_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const uploadSignedContract = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const dealId = req.params.id;
    const { contract_id, file_url } = req.body;
    
    // Create signed url
    const { data: urlData, error: urlError } = await supabase.storage.from('crm-contracts').createSignedUrl(file_url, 60 * 60 * 24 * 365 * 10);
    if (urlError) throw urlError;

    const { data, error } = await supabase.from('crm_deal_contracts').update({
      signed_file_url: urlData?.signedUrl,
      signed_uploaded_at: new Date().toISOString(),
      signed_uploaded_by: req.user?.id,
      status: 'Assinado',
    }).eq('id', contract_id).select().single();
    if (error) throw error;

    // Fetch the deal's current stage to identify the pipeline
    let wonStageId = null;
    let oldStageId = null;
    const { data: dealRecord } = await supabase
      .from('crm_deals')
      .select('stage_id')
      .eq('id', dealId)
      .single();

    if (dealRecord?.stage_id) {
      oldStageId = dealRecord.stage_id;
      // Find the pipeline_id of this stage
      const { data: currentStage } = await supabase
        .from('crm_pipeline_stages')
        .select('pipeline_id')
        .eq('id', dealRecord.stage_id)
        .single();

      if (currentStage?.pipeline_id) {
        // Find the "Fechado Ganho" (is_won = true) stage in that pipeline
        const { data: wonStage } = await supabase
          .from('crm_pipeline_stages')
          .select('id')
          .eq('pipeline_id', currentStage.pipeline_id)
          .eq('is_won', true)
          .single();

        if (wonStage) {
          wonStageId = wonStage.id;
        }
      }
    }

    const dealUpdates: any = { active_contract_id: contract_id };
    if (wonStageId) {
      dealUpdates.stage_id = wonStageId;
      dealUpdates.closed_at = new Date().toISOString();
      dealUpdates.probability_pct = 100;
    }

    await supabase.from('crm_deals').update(dealUpdates).eq('id', dealId);

    // If stage changed, log the activity
    if (wonStageId && oldStageId && wonStageId !== oldStageId) {
      await supabase.from('crm_deal_activities').insert([{
        deal_id: dealId,
        activity_type: 'stage_change',
        description: 'Alteração automática de etapa (Contrato Assinado)',
        stage_from_id: oldStageId,
        stage_to_id: wonStageId,
        performed_by: req.user?.id
      }]);
    }

    // Send email notification to logistics team
    try {
      const { data: fullDeal } = await supabase.from('crm_deals').select('title').eq('id', dealId).single();
      const snapshot = data.snapshot || {};
      
      const { data: logisticUsers } = await supabaseAdmin
        .from('users_profiles')
        .select('email')
        .eq('access_level', 'Logística')
        .eq('active', true)
        .not('email', 'is', null);
      
      const emails = new Set<string>();
      emails.add('victorhsltech@gmail.com');
      if (logisticUsers) {
        logisticUsers.forEach(u => {
          if (u.email) emails.add(u.email);
        });
      }

      await emailService.sendSignedContractNotification({
        to: Array.from(emails),
        clientName: snapshot.locatario?.company_name || 'Cliente',
        contractNumber: data.contract_number,
        equipmentDescription: snapshot.equipment?.description || 'Equipamento',
        dealTitle: fullDeal?.title || 'Negociação',
        signedFileUrl: urlData?.signedUrl || '#'
      });
    } catch (emailErr) {
      console.error('[crmController] Erro ao enviar notificação interna de contrato assinado:', emailErr);
    }

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteContractRecord = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const dealId = req.params.id;
    const contractId = req.params.contractId;

    // Fetch the deal to check owner_id
    const { data: deal, error: dealError } = await supabase
      .from('crm_deals')
      .select('owner_id')
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return res.status(404).json({ error: 'Negociação não encontrada' });
    }

    const isOwner = deal.owner_id === req.user?.id;
    const hasPrivilegedRole = ['Administrador', 'Diretoria', 'Gerente'].includes(req.profile?.access_level);

    if (!isOwner && !hasPrivilegedRole) {
      return res.status(403).json({ error: 'Permissão negada para excluir o contrato' });
    }

    // Reset active_contract_id on the deal if it matches this contract
    await supabase.from('crm_deals').update({ active_contract_id: null }).eq('id', dealId).eq('active_contract_id', contractId);

    // Delete the contract record
    const { error: deleteError } = await supabase
      .from('crm_deal_contracts')
      .delete()
      .eq('id', contractId);

    if (deleteError) throw deleteError;

    // Reset form status on contract form back to 'Pronto para Gerar'
    await supabase.from('crm_deal_contract_forms').update({ form_status: 'Pronto para Gerar' }).eq('deal_id', dealId);

    res.json({ message: 'Contrato excluído com sucesso' });
  } catch (error: any) {
    console.error('[crmController] Erro em deleteContractRecord:', error);
    res.status(500).json({ error: error.message });
  }
};

export const sendContractEmail = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const dealId = req.params.id;
    const contractId = req.params.contractId;
    const { pdf_base64 } = req.body; // Base64-encoded PDF from frontend

    // 1. Get contract record
    const { data: contract, error: contractError } = await supabase
      .from('crm_deal_contracts')
      .select('*')
      .eq('id', contractId)
      .single();
    if (contractError || !contract) throw new Error('Contrato não encontrado');

    // 2. Get deal info
    const { data: deal, error: dealError } = await supabase
      .from('crm_deals')
      .select('*, primary_contact_id, client_id, lead_id')
      .eq('id', dealId)
      .single();
    if (dealError || !deal) throw new Error('Negociação não encontrada');

    // 3. Find the primary contact email
    let contactEmail = '';
    let contactName = '';

    if (deal.primary_contact_id) {
      const { data: contact } = await supabase
        .from('crm_contacts')
        .select('full_name, email')
        .eq('id', deal.primary_contact_id)
        .single();
      if (contact) {
        contactEmail = contact.email || '';
        contactName = contact.full_name || '';
      }
    }

    // Fallback: try other contacts linked to the client or lead
    if (!contactEmail) {
      const filter: any = {};
      if (deal.client_id) filter.client_id = deal.client_id;
      else if (deal.lead_id) filter.lead_id = deal.lead_id;

      if (Object.keys(filter).length > 0) {
        const key = Object.keys(filter)[0];
        const { data: contacts } = await supabase
          .from('crm_contacts')
          .select('full_name, email')
          .eq(key, filter[key])
          .eq('active', true)
          .order('is_primary', { ascending: false })
          .limit(1);
        if (contacts && contacts.length > 0 && contacts[0].email) {
          contactEmail = contacts[0].email;
          contactName = contacts[0].full_name || '';
        }
      }
    }

    // Last fallback: client email
    if (!contactEmail && deal.client_id) {
      const { data: client } = await supabase
        .from('clients')
        .select('company_name, email')
        .eq('id', deal.client_id)
        .single();
      if (client?.email) {
        contactEmail = client.email;
        contactName = contactName || client.company_name || '';
      }
    }

    if (!contactEmail) {
      return res.status(400).json({ error: 'Nenhum e-mail de contato encontrado para este negócio' });
    }

    // 4. Upload PDF to Supabase storage if base64 was provided
    const snapshot = contract.snapshot || {};
    const pdfFilename = `PROPOSTA DE LOCAÇÃO - ${snapshot.locatario?.company_name || 'Contrato'}.pdf`;
    let downloadUrl = '';

    if (pdf_base64) {
      const pdfBuffer = Buffer.from(pdf_base64, 'base64');
      const storagePath = `${dealId}/${contractId}/proposta.pdf`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from('crm-contracts')
        .upload(storagePath, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true,
        });
      if (uploadError) {
        console.error('[crmController] Erro ao fazer upload do PDF:', uploadError);
      }

      // Generate signed URL (10 years)
      const { data: urlData } = await supabaseAdmin.storage
        .from('crm-contracts')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365 * 10);
      downloadUrl = urlData?.signedUrl || '';

      // Update contract record with the PDF URL
      await supabase.from('crm_deal_contracts').update({
        pdf_url: downloadUrl,
      }).eq('id', contractId);
    }

    // 5. Get company settings for the from name
    const { data: settings } = await supabaseAdmin
      .from('erp_company_settings')
      .select('company_name')
      .eq('active', true)
      .single();
    const companyName = settings?.company_name || 'C3Loc';

    // 6. Send email
    await emailService.sendContractEmail({
      to: contactEmail,
      contactName: contactName || snapshot.locatario?.company_name || 'Cliente',
      companyName,
      contractNumber: contract.contract_number,
      equipmentDescription: snapshot.equipment?.description || 'Equipamento',
      totalValue: Number(snapshot.costs?.total) || 0,
      downloadUrl: downloadUrl || '#',
      pdfBase64: pdf_base64 || undefined,
      pdfFilename,
    });

    res.json({ message: 'E-mail enviado com sucesso', sentTo: contactEmail });
  } catch (error: any) {
    console.error('[crmController] Erro em sendContractEmail:', error);
    res.status(500).json({ error: error.message });
  }
};
