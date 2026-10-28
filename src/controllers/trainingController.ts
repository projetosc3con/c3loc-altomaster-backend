import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';
import {
  CreateTrainingDTO,
  AssignTrainingDTO,
  UpdateProgressDTO,
  TrainingStatus,
} from '../types/training';

const isTrainingManager = (accessLevel?: string): boolean => {
  return accessLevel === 'Administrador' || accessLevel === 'Diretoria';
};

const calculateDerivedStatus = (status: string, dueDate?: string | null): TrainingStatus => {
  if (status === 'Concluído') return 'Concluído';
  if (dueDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate + 'T23:59:59');
    if (due < today) {
      return 'Vencido';
    }
  }
  return status === 'Em Andamento' ? 'Em Andamento' : 'Pendente';
};

/**
 * GET /api/trainings
 * Lista treinamentos com base no papel do usuário e no query param `view`.
 * - Colaborador geral: lista cursos atribuídos a ele.
 * - Administrador / Diretoria: pode alternar entre `view=my` (seus) e `view=catalog` (todos os cursos cadastrados).
 */
export const getTrainings = async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    const profile = req.profile;
    const isManager = isTrainingManager(profile?.access_level);
    const view = (req.query.view as string) || (isManager ? 'catalog' : 'my');
    const supabase = getSupabaseUserClient(req.token!);

    // Visão do Catálogo (Administrador / Diretoria)
    if (isManager && view === 'catalog') {
      const { data: trainings, error: trainingsError } = await supabaseAdmin
        .from('trainings')
        .select(`
          *,
          category:training_categories(*),
          creator:users_profiles!trainings_created_by_fkey(id, full_name, email, role_title, photo_url),
          topics:training_topics(
            id, position, start_seconds, end_seconds, description,
            topic:training_topic_catalog(id, name, description)
          ),
          assignments:training_assignments(
            id, user_id, status, due_date, progress_pct, last_position_seconds,
            user:users_profiles!training_assignments_user_id_fkey(id, full_name, email, role_title, photo_url, access_level)
          )
        `)
        .order('created_at', { ascending: false });

      if (trainingsError) throw trainingsError;

      const formatted = (trainings || []).map((t: any) => {
        // Ordena tópicos por position
        if (Array.isArray(t.topics)) {
          t.topics.sort((a: any, b: any) => a.position - b.position || a.start_seconds - b.start_seconds);
        }

        const myAssignment = (t.assignments || []).find((a: any) => a.user_id === user.id);
        const derivedStatus = myAssignment
          ? calculateDerivedStatus(myAssignment.status, myAssignment.due_date)
          : undefined;

        return {
          ...t,
          can_delete: profile?.access_level === 'Administrador' || t.created_by === user.id,
          my_assignment: myAssignment
            ? {
                ...myAssignment,
                derived_status: derivedStatus,
              }
            : null,
          total_enrolled: (t.assignments || []).length,
          completed_count: (t.assignments || []).filter((a: any) => a.status === 'Concluído').length,
        };
      });

      return res.json(formatted);
    }

    // Visão do Colaborador: cursos atribuídos ao usuário logado
    const { data: assignments, error: assignmentsError } = await supabaseAdmin
      .from('training_assignments')
      .select(`
        id,
        training_id,
        user_id,
        status,
        due_date,
        progress_pct,
        last_position_seconds,
        max_position_seconds,
        started_at,
        completed_at,
        last_accessed_at,
        notes,
        created_at,
        updated_at,
        training:trainings(
          id, title, subtitle, description, category_id, level,
          youtube_url, youtube_video_id, duration_seconds, instructor_name,
          objectives, is_mandatory, default_due_days, active, created_by, created_at,
          category:training_categories(*),
          topics:training_topics(
            id, position, start_seconds, end_seconds, description,
            topic:training_topic_catalog(id, name, description)
          )
        )
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (assignmentsError) throw assignmentsError;

    const formatted = (assignments || [])
      .filter((a: any) => a.training && a.training.active)
      .map((a: any) => {
        const t = a.training;
        if (Array.isArray(t.topics)) {
          t.topics.sort((x: any, y: any) => x.position - y.position || x.start_seconds - y.start_seconds);
        }

        const derivedStatus = calculateDerivedStatus(a.status, a.due_date);

        return {
          ...t,
          assignment_id: a.id,
          status: a.status,
          derived_status: derivedStatus,
          due_date: a.due_date,
          progress_pct: a.progress_pct,
          last_position_seconds: a.last_position_seconds,
          max_position_seconds: a.max_position_seconds,
          started_at: a.started_at,
          completed_at: a.completed_at,
          last_accessed_at: a.last_accessed_at,
          notes: a.notes,
          my_assignment: {
            ...a,
            derived_status: derivedStatus,
          },
          can_delete: profile?.access_level === 'Administrador' || (isManager && t.created_by === user.id),
        };
      });

    return res.json(formatted);
  } catch (error: any) {
    console.error('[getTrainings] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao buscar treinamentos' });
  }
};

/**
 * GET /api/trainings/categories
 * Lista as categorias de treinamento.
 */
export const getCategories = async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('training_categories')
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Erro ao carregar categorias' });
  }
};

/**
 * GET /api/trainings/topics-catalog
 * Lista os tópicos disponíveis no catálogo.
 */
export const getTopicCatalog = async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('training_topic_catalog')
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Erro ao carregar catálogo de tópicos' });
  }
};

/**
 * GET /api/trainings/:id
 * Retorna detalhes do treinamento, incluindo capítulos/tópicos e dados de atribuição.
 */
export const getTrainingById = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user;
  const isManager = isTrainingManager(req.profile?.access_level);

  try {
    const { data: training, error } = await supabaseAdmin
      .from('trainings')
      .select(`
        *,
        category:training_categories(*),
        creator:users_profiles!trainings_created_by_fkey(id, full_name, email, role_title, photo_url),
        topics:training_topics(
          id, topic_id, position, start_seconds, end_seconds, description,
          topic:training_topic_catalog(id, name, description)
        ),
        assignments:training_assignments(
          id, user_id, status, due_date, progress_pct, last_position_seconds,
          max_position_seconds, started_at, completed_at, last_accessed_at, notes,
          user:users_profiles!training_assignments_user_id_fkey(id, full_name, email, role_title, photo_url, access_level)
        )
      `)
      .eq('id', id)
      .single();

    if (error || !training) {
      return res.status(404).json({ error: 'Treinamento não encontrado' });
    }

    // Ordena tópicos por ordem cronológica e posição
    if (Array.isArray(training.topics)) {
      training.topics.sort(
        (a: any, b: any) => a.position - b.position || a.start_seconds - b.start_seconds
      );
    }

    const myAssignment = (training.assignments || []).find((a: any) => a.user_id === user.id);
    const derivedStatus = myAssignment
      ? calculateDerivedStatus(myAssignment.status, myAssignment.due_date)
      : undefined;

    // Se não for gestor e o curso não estiver atribuído a ele, restringe o acesso
    if (!isManager && !myAssignment) {
      return res.status(403).json({ error: 'Você não possui acesso a este treinamento' });
    }

    const responseData = {
      ...training,
      can_delete: req.profile?.access_level === 'Administrador' || (isManager && training.created_by === user.id),
      can_manage: isManager,
      my_assignment: myAssignment
        ? {
            ...myAssignment,
            derived_status: derivedStatus,
          }
        : null,
      assignments: isManager ? training.assignments : undefined,
    };

    return res.json(responseData);
  } catch (error: any) {
    console.error('[getTrainingById] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao buscar treinamento' });
  }
};

/**
 * POST /api/trainings
 * Cria um novo treinamento com seus tópicos associados.
 * Permissão: Administrador ou Diretoria.
 */
export const createTraining = async (req: AuthRequest, res: Response) => {
  const user = req.user;
  const isManager = isTrainingManager(req.profile?.access_level);

  if (!isManager) {
    return res.status(403).json({ error: 'Apenas Administrador e Diretoria podem cadastrar treinamentos' });
  }

  const payload: CreateTrainingDTO = req.body;

  if (!payload.title || !payload.category_id || !payload.youtube_url || !payload.duration_seconds) {
    return res.status(400).json({
      error: 'Título, categoria, link do vídeo do YouTube e duração são obrigatórios.',
    });
  }

  try {
    // 1. Insere o treinamento principal
    const { data: training, error: trainingError } = await supabaseAdmin
      .from('trainings')
      .insert({
        title: payload.title.trim(),
        subtitle: payload.subtitle ? payload.subtitle.trim() : null,
        description: payload.description ? payload.description.trim() : null,
        category_id: payload.category_id,
        level: payload.level || 'Iniciante',
        youtube_url: payload.youtube_url.trim(),
        duration_seconds: Math.round(Number(payload.duration_seconds)),
        instructor_name: payload.instructor_name ? payload.instructor_name.trim() : req.profile?.full_name,
        objectives: Array.isArray(payload.objectives) ? payload.objectives : [],
        is_mandatory: Boolean(payload.is_mandatory),
        default_due_days: payload.default_due_days ? Number(payload.default_due_days) : null,
        active: true,
        created_by: user.id,
      })
      .select()
      .single();

    if (trainingError) throw trainingError;

    // 2. Insere os tópicos associados (se fornecidos)
    if (Array.isArray(payload.topics) && payload.topics.length > 0) {
      for (let i = 0; i < payload.topics.length; i++) {
        const item = payload.topics[i];
        let topicId = item.topic_id;

        // Se informou nome em vez de id de catálogo, busca ou cria no catálogo
        if (!topicId && item.topic_name) {
          const { data: existingTopic } = await supabaseAdmin
            .from('training_topic_catalog')
            .select('id')
            .ilike('name', item.topic_name.trim())
            .maybeSingle();

          if (existingTopic) {
            topicId = existingTopic.id;
          } else {
            const { data: newCatalogTopic } = await supabaseAdmin
              .from('training_topic_catalog')
              .insert({
                name: item.topic_name.trim(),
                created_by: user.id,
              })
              .select('id')
              .single();

            if (newCatalogTopic) {
              topicId = newCatalogTopic.id;
            }
          }
        }

        if (topicId) {
          await supabaseAdmin.from('training_topics').insert({
            training_id: training.id,
            topic_id: topicId,
            position: item.position ?? i + 1,
            start_seconds: Math.max(0, Math.round(Number(item.start_seconds || 0))),
            end_seconds: item.end_seconds ? Math.round(Number(item.end_seconds)) : null,
            description: item.description ? item.description.trim() : null,
            created_by: user.id,
          });
        }
      }
    }

    return res.status(201).json(training);
  } catch (error: any) {
    console.error('[createTraining] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao criar treinamento' });
  }
};

/**
 * PUT /api/trainings/:id
 * Atualiza um treinamento existente.
 * Permissão: Administrador ou Diretoria.
 */
export const updateTraining = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user;
  const isManager = isTrainingManager(req.profile?.access_level);

  if (!isManager) {
    return res.status(403).json({ error: 'Apenas Administrador e Diretoria podem atualizar treinamentos' });
  }

  const payload: Partial<CreateTrainingDTO> = req.body;

  try {
    const updateData: any = {
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    };

    if (payload.title !== undefined) updateData.title = payload.title.trim();
    if (payload.subtitle !== undefined) updateData.subtitle = payload.subtitle?.trim() || null;
    if (payload.description !== undefined) updateData.description = payload.description?.trim() || null;
    if (payload.category_id !== undefined) updateData.category_id = payload.category_id;
    if (payload.level !== undefined) updateData.level = payload.level;
    if (payload.youtube_url !== undefined) updateData.youtube_url = payload.youtube_url.trim();
    if (payload.duration_seconds !== undefined) updateData.duration_seconds = Math.round(Number(payload.duration_seconds));
    if (payload.instructor_name !== undefined) updateData.instructor_name = payload.instructor_name?.trim() || null;
    if (payload.objectives !== undefined) updateData.objectives = payload.objectives;
    if (payload.is_mandatory !== undefined) updateData.is_mandatory = Boolean(payload.is_mandatory);
    if (payload.default_due_days !== undefined) updateData.default_due_days = payload.default_due_days ? Number(payload.default_due_days) : null;

    const { data: updated, error } = await supabaseAdmin
      .from('trainings')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Se tópicos foram enviados, recria a lista
    if (Array.isArray(payload.topics)) {
      await supabaseAdmin.from('training_topics').delete().eq('training_id', id);

      for (let i = 0; i < payload.topics.length; i++) {
        const item = payload.topics[i];
        let topicId = item.topic_id;

        if (!topicId && item.topic_name) {
          const { data: existingTopic } = await supabaseAdmin
            .from('training_topic_catalog')
            .select('id')
            .ilike('name', item.topic_name.trim())
            .maybeSingle();

          if (existingTopic) {
            topicId = existingTopic.id;
          } else {
            const { data: newCatalogTopic } = await supabaseAdmin
              .from('training_topic_catalog')
              .insert({
                name: item.topic_name.trim(),
                created_by: user.id,
              })
              .select('id')
              .single();

            if (newCatalogTopic) {
              topicId = newCatalogTopic.id;
            }
          }
        }

        if (topicId) {
          await supabaseAdmin.from('training_topics').insert({
            training_id: id,
            topic_id: topicId,
            position: item.position ?? i + 1,
            start_seconds: Math.max(0, Math.round(Number(item.start_seconds || 0))),
            end_seconds: item.end_seconds ? Math.round(Number(item.end_seconds)) : null,
            description: item.description ? item.description.trim() : null,
            created_by: user.id,
          });
        }
      }
    }

    return res.json(updated);
  } catch (error: any) {
    console.error('[updateTraining] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao atualizar treinamento' });
  }
};

/**
 * DELETE /api/trainings/:id
 * Exclui um treinamento.
 * REGRA DO NEGÓCIO:
 * - 'Administrador' pode excluir qualquer treinamento.
 * - 'Diretoria' pode excluir apenas treinamentos cadastrados por si.
 */
export const deleteTraining = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user;
  const isAdmin = req.profile?.access_level === 'Administrador';
  const isManager = isTrainingManager(req.profile?.access_level);

  if (!isManager) {
    return res.status(403).json({ error: 'Apenas Administrador e Diretoria podem excluir treinamentos' });
  }

  try {
    const { data: training, error: fetchError } = await supabaseAdmin
      .from('trainings')
      .select('id, created_by, title')
      .eq('id', id)
      .single();

    if (fetchError || !training) {
      return res.status(404).json({ error: 'Treinamento não encontrado' });
    }

    // Regra: Diretoria somente pode excluir treinamentos cadastrados por si próprio; Administrador pode excluir qualquer um
    if (!isAdmin && training.created_by !== user.id) {
      return res.status(403).json({
        error: 'Você só pode excluir treinamentos cadastrados por você mesmo.',
      });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('trainings')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    return res.status(204).send();
  } catch (error: any) {
    console.error('[deleteTraining] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao excluir treinamento' });
  }
};

/**
 * POST /api/trainings/:id/assign
 * Atribui o treinamento a colaboradores.
 * REGRA DO NEGÓCIO:
 * - Somente 'Administrador' e 'Diretoria'.
 * - Usuários do tipo 'Diretoria' não devem poder gerir os treinamentos atribuídos a si mesmos.
 */
export const assignTraining = async (req: AuthRequest, res: Response) => {
  const { id: trainingId } = req.params;
  const user = req.user;
  const profile = req.profile;
  const isManager = isTrainingManager(profile?.access_level);

  if (!isManager) {
    return res.status(403).json({ error: 'Apenas Administrador e Diretoria podem atribuir treinamentos' });
  }

  const { user_ids, due_date, notes }: AssignTrainingDTO = req.body;

  if (!Array.isArray(user_ids) || user_ids.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos um colaborador para atribuir o treinamento' });
  }

  // Regra de negócio: Usuário 'Diretoria' não pode gerir treinamentos atribuídos a si mesmo
  if (profile.access_level === 'Diretoria' && user_ids.includes(user.id)) {
    return res.status(403).json({
      error: 'Usuários do tipo Diretoria não podem gerir ou atribuir treinamentos a si mesmos.',
    });
  }

  try {
    const { data: training } = await supabaseAdmin
      .from('trainings')
      .select('id, default_due_days')
      .eq('id', trainingId)
      .single();

    if (!training) {
      return res.status(404).json({ error: 'Treinamento não encontrado' });
    }

    let calculatedDueDate = due_date;
    if (!calculatedDueDate && training.default_due_days) {
      const d = new Date();
      d.setDate(d.getDate() + training.default_due_days);
      calculatedDueDate = d.toISOString().split('T')[0];
    }

    const assignmentsToUpsert = user_ids.map((uid) => ({
      training_id: trainingId,
      user_id: uid,
      due_date: calculatedDueDate || null,
      notes: notes || null,
      created_by: user.id,
    }));

    const { data, error } = await supabaseAdmin
      .from('training_assignments')
      .upsert(assignmentsToUpsert, { onConflict: 'training_id,user_id' })
      .select(`
        id, training_id, user_id, status, due_date, progress_pct,
        user:users_profiles!training_assignments_user_id_fkey(id, full_name, email, role_title, photo_url)
      `);

    if (error) throw error;

    return res.status(200).json(data);
  } catch (error: any) {
    console.error('[assignTraining] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao atribuir treinamento' });
  }
};

/**
 * DELETE /api/trainings/:id/assign/:assignmentId
 * Remove a atribuição de um treinamento.
 * REGRA: Diretoria não pode gerir atribuição de si mesma.
 */
export const unassignTraining = async (req: AuthRequest, res: Response) => {
  const { assignmentId } = req.params;
  const user = req.user;
  const profile = req.profile;
  const isManager = isTrainingManager(profile?.access_level);

  if (!isManager) {
    return res.status(403).json({ error: 'Apenas Administrador e Diretoria podem desatribuir treinamentos' });
  }

  try {
    const { data: assignment, error: fetchError } = await supabaseAdmin
      .from('training_assignments')
      .select('id, user_id')
      .eq('id', assignmentId)
      .single();

    if (fetchError || !assignment) {
      return res.status(404).json({ error: 'Atribuição não encontrada' });
    }

    // Regra: Diretoria não pode gerir atribuição de si mesma
    if (profile.access_level === 'Diretoria' && assignment.user_id === user.id) {
      return res.status(403).json({
        error: 'Usuários do tipo Diretoria não podem gerir atribuições para si mesmos.',
      });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('training_assignments')
      .delete()
      .eq('id', assignmentId);

    if (deleteError) throw deleteError;

    return res.status(204).send();
  } catch (error: any) {
    console.error('[unassignTraining] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao remover atribuição' });
  }
};

/**
 * PATCH /api/trainings/assignments/:id/progress
 * Atualiza onde o usuário parou (segundos) e o progresso percentual.
 * Permissão: o próprio colaborador atribuído.
 */
export const updateProgress = async (req: AuthRequest, res: Response) => {
  const { id: assignmentId } = req.params;
  const user = req.user;
  const { position_seconds }: UpdateProgressDTO = req.body;

  if (position_seconds === undefined || isNaN(Number(position_seconds))) {
    return res.status(400).json({ error: 'Posição em segundos é obrigatória' });
  }

  try {
    // 1. Busca a atribuição e a duração total do curso
    const { data: assignment, error: fetchError } = await supabaseAdmin
      .from('training_assignments')
      .select('*, training:trainings(id, duration_seconds)')
      .eq('id', assignmentId)
      .single();

    if (fetchError || !assignment) {
      return res.status(404).json({ error: 'Atribuição não encontrada' });
    }

    // Validação de segurança: apenas o próprio colaborador altera seu progresso
    if (assignment.user_id !== user.id) {
      return res.status(403).json({ error: 'Você só pode registrar o progresso das suas próprias aulas' });
    }

    const duration = assignment.training?.duration_seconds || 1;
    const currentPos = Math.max(0, Math.min(Math.round(Number(position_seconds)), duration));
    
    // Evita trapaça com saltos: só expande o max se o avanço for plausível
    const prevMax = assignment.max_position_seconds || 0;
    const maxPos = currentPos <= prevMax + 45 ? Math.max(prevMax, currentPos) : prevMax;
    let pct = Math.min(100, Math.round((maxPos / duration) * 100));

    let newStatus = assignment.status;
    if (assignment.status === 'Concluído' || pct >= 95) {
      newStatus = 'Concluído';
      pct = 100;
    } else if (maxPos > 0 || currentPos > 0) {
      newStatus = 'Em Andamento';
    }

    const updateData: any = {
      last_position_seconds: currentPos,
      max_position_seconds: maxPos,
      progress_pct: Math.max(Number(assignment.progress_pct || 0), pct),
      status: newStatus,
      last_accessed_at: new Date().toISOString(),
      started_at: assignment.started_at || new Date().toISOString(),
    };

    if (newStatus === 'Concluído' && !assignment.completed_at) {
      updateData.completed_at = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('training_assignments')
      .update(updateData)
      .eq('id', assignmentId)
      .select()
      .single();

    if (updateError) throw updateError;

    return res.json({
      ...updated,
      derived_status: calculateDerivedStatus(updated.status, updated.due_date),
    });
  } catch (error: any) {
    console.error('[updateProgress] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao registrar progresso' });
  }
};

/**
 * PATCH /api/trainings/assignments/:id/complete
 * Marca o treinamento como concluído diretamente pelo colaborador.
 */
export const completeTraining = async (req: AuthRequest, res: Response) => {
  const { id: assignmentId } = req.params;
  const user = req.user;
  const isManager = isTrainingManager(req.profile?.access_level);

  try {
    const { data: assignment, error: fetchError } = await supabaseAdmin
      .from('training_assignments')
      .select('id, user_id, status, due_date')
      .eq('id', assignmentId)
      .single();

    if (fetchError || !assignment) {
      return res.status(404).json({ error: 'Atribuição não encontrada' });
    }

    if (!isManager && assignment.user_id !== user.id) {
      return res.status(403).json({ error: 'Você só pode concluir suas próprias atribuições' });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('training_assignments')
      .update({
        status: 'Concluído',
        progress_pct: 100,
        completed_at: new Date().toISOString(),
        last_accessed_at: new Date().toISOString(),
      })
      .eq('id', assignmentId)
      .select()
      .single();

    if (updateError) throw updateError;

    return res.json({
      ...updated,
      derived_status: 'Concluído',
    });
  } catch (error: any) {
    console.error('[completeTraining] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao concluir treinamento' });
  }
};

/**
 * GET /api/trainings/assignments/all
 * Lista todas as atribuições cadastradas para acompanhamento dos gestores (Administrador / Diretoria).
 */
export const getAllAssignments = async (req: AuthRequest, res: Response) => {
  const isManager = isTrainingManager(req.profile?.access_level);
  if (!isManager) {
    return res.status(403).json({ error: 'Apenas Administrador e Diretoria podem visualizar todas as atribuições' });
  }

  try {
    const { data: assignments, error } = await supabaseAdmin
      .from('training_assignments')
      .select(`
        id,
        training_id,
        user_id,
        status,
        due_date,
        progress_pct,
        last_position_seconds,
        max_position_seconds,
        started_at,
        completed_at,
        last_accessed_at,
        notes,
        created_at,
        updated_at,
        training:trainings(
          id, title, duration_seconds, level,
          category:training_categories(id, name, icon)
        ),
        user:users_profiles!training_assignments_user_id_fkey(
          id, full_name, email, role_title, photo_url, access_level
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const formatted = (assignments || []).map((a: any) => {
      const derivedStatus = calculateDerivedStatus(a.status, a.due_date);
      return {
        ...a,
        derived_status: derivedStatus,
      };
    });

    return res.json(formatted);
  } catch (error: any) {
    console.error('[getAllAssignments] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao carregar atribuições' });
  }
};

/**
 * DELETE /api/trainings/assignments/:id
 * Remove atribuição direta pelo ID da atribuição.
 */
export const unassignTrainingById = async (req: AuthRequest, res: Response) => {
  const { id: assignmentId } = req.params;
  const user = req.user;
  const profile = req.profile;
  const isManager = isTrainingManager(profile?.access_level);

  if (!isManager) {
    return res.status(403).json({ error: 'Apenas Administrador e Diretoria podem remover atribuições' });
  }

  try {
    const { data: assignment, error: fetchError } = await supabaseAdmin
      .from('training_assignments')
      .select('id, user_id')
      .eq('id', assignmentId)
      .single();

    if (fetchError || !assignment) {
      return res.status(404).json({ error: 'Atribuição não encontrada' });
    }

    // Regra: Diretoria não pode gerir atribuição de si mesma
    if (profile.access_level === 'Diretoria' && assignment.user_id === user.id) {
      return res.status(403).json({
        error: 'Usuários do tipo Diretoria não podem gerir atribuições para si mesmos.',
      });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('training_assignments')
      .delete()
      .eq('id', assignmentId);

    if (deleteError) throw deleteError;

    return res.status(204).send();
  } catch (error: any) {
    console.error('[unassignTrainingById] Erro:', error);
    return res.status(500).json({ error: error.message || 'Erro ao remover atribuição' });
  }
};
