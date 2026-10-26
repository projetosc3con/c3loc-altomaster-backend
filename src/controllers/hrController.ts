import { Request, Response } from 'express';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';

export const getPositions = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    // Fetch positions
    const { data: positions, error: positionsError } = await supabase
      .from('hr_positions')
      .select('*')
      .eq('active', true)
      .order('title');

    if (positionsError) throw positionsError;

    // Fetch salary ranges to get levels for each position
    const { data: salaryRanges, error: salaryRangesError } = await supabase
      .from('hr_salary_ranges')
      .select('position_id, salary_min, salary_mid, salary_max, hr_job_levels(name)');

    if (salaryRangesError) throw salaryRangesError;

    // Fetch employee counts per position
    const { data: employeePositions, error: empPosError } = await supabase
      .from('hr_employee_positions')
      .select('position_id')
      .is('end_date', null);

    if (empPosError) throw empPosError;

    // Process data to match frontend expectations
    const formattedPositions = positions.map((pos: any) => {
      // Find levels for this position
      const posRanges = salaryRanges
        .filter((sr: any) => sr.position_id === pos.id && sr.hr_job_levels);

      const uniqueLevels = [...new Set(posRanges.map((sr: any) => sr.hr_job_levels.name))];

      const ranges = posRanges.map((sr: any) => ({
        level: sr.hr_job_levels.name,
        min: sr.salary_min,
        mid: sr.salary_mid,
        max: sr.salary_max
      }));

      // Count employees
      const employeeCount = employeePositions.filter((ep: any) => ep.position_id === pos.id).length;

      return {
        id: pos.id,
        name: pos.title,
        department: pos.department,
        levels: uniqueLevels,
        ranges: ranges,
        employees: employeeCount
      };
    });

    res.json(formattedPositions);
  } catch (error: any) {
    console.error('Error fetching HR positions:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getLevels = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: levels, error } = await supabase
      .from('hr_job_levels')
      .select('*')
      .order('created_at');

    if (error) throw error;

    res.json(levels);
  } catch (error: any) {
    console.error('Error fetching HR levels:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createLevel = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'O nome do nível é obrigatório.' });
    }

    const { data, error } = await supabase
      .from('hr_job_levels')
      .insert([{ name: name.trim(), description: description ? description.trim() : null }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (error: any) {
    console.error('Error creating HR level:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getLevelById = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { data, error } = await supabase
      .from('hr_job_levels')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching HR level by ID:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const updateLevel = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'O nome do nível é obrigatório.' });
    }

    const { data, error } = await supabase
      .from('hr_job_levels')
      .update({
        name: name.trim(),
        description: description ? description.trim() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error updating HR level:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const deleteLevel = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { error } = await supabase
      .from('hr_job_levels')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Nível excluído com sucesso.' });
  } catch (error: any) {
    console.error('Error deleting HR level:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployees = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    // Fetch active users
    const { data: users, error: usersError } = await supabase
      .from('users_profiles')
      .select('id, full_name, email, role_title, photo_url')
      .eq('active', true);

    if (usersError) throw usersError;

    // Fetch current positions for all users
    const { data: currentPositions, error: positionsError } = await supabase
      .from('hr_employee_positions')
      .select('user_id, position_id, salary, hr_positions(title, department), hr_job_levels(name)')
      .is('end_date', null)
      .returns<any[]>();

    if (positionsError) throw positionsError;

    // Fetch position document requirements
    const { data: positionDocs, error: positionDocsError } = await supabase
      .from('hr_position_document_types')
      .select('position_id, document_type_id')
      .eq('mandatory', true);

    if (positionDocsError) throw positionDocsError;

    // Fetch uploaded employee documents
    const { data: employeeDocs, error: employeeDocsError } = await supabase
      .from('hr_employee_documents')
      .select('user_id, document_type_id');

    if (employeeDocsError) throw employeeDocsError;

    // Map users with their positions
    const formattedEmployees = users.map((user: any) => {
      const currentPos = currentPositions.find((cp: any) => cp.user_id === user.id);

      let missingDocsCount = 0;
      if (currentPos?.position_id) {
        const requiredDocs = positionDocs.filter((pd: any) => pd.position_id === currentPos.position_id);
        const userUploadedDocs = employeeDocs.filter((ed: any) => ed.user_id === user.id);

        missingDocsCount = requiredDocs.filter((req: any) =>
          !userUploadedDocs.some((upl: any) => upl.document_type_id === req.document_type_id)
        ).length;
      }

      return {
        id: user.id,
        name: user.full_name,
        email: user.email,
        photo_url: user.photo_url,
        positionTitle: currentPos?.hr_positions?.title || null,
        department: currentPos?.hr_positions?.department || null,
        levelName: currentPos?.hr_job_levels?.name || null,
        salary: currentPos?.salary || null,
        missingDocsCount: currentPos ? missingDocsCount : null,
      };
    });

    res.json(formattedEmployees);
  } catch (error: any) {
    console.error('Error fetching HR employees:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployeeById = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { id } = req.params;

    // Fetch user profile
    const { data: user, error: userError } = await supabase
      .from('users_profiles')
      .select('*')
      .eq('id', id)
      .single();

    if (userError) throw userError;
    if (!user) return res.status(404).json({ error: 'Employee not found' });

    // Fetch current position
    const { data: currentPos, error: posError } = await supabase
      .from('hr_employee_positions')
      .select('id, position_id, salary, start_date, hr_positions(title, department), hr_job_levels(name)')
      .eq('user_id', id)
      .is('end_date', null)
      .returns<any[]>()
      .maybeSingle();

    if (posError) throw posError;

    res.json({
      ...user,
      position: currentPos ? {
        id: currentPos.id,
        position_id: currentPos.position_id,
        title: currentPos.hr_positions?.title || null,
        department: currentPos.hr_positions?.department || null,
        level: currentPos.hr_job_levels?.name || null,
        salary: currentPos.salary,
        start_date: currentPos.start_date,
      } : null,
    });
  } catch (error: any) {
    console.error('Error fetching employee by ID:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const updateEmployee = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { id } = req.params;

    // Only allow updating these fields (never email)
    const allowedFields = [
      'full_name', 'cpf', 'birth_date', 'phone',
      'address_street', 'address_number', 'address_complement',
      'address_city', 'address_state', 'address_zip',
    ];

    const updateData: any = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field] || null;
      }
    }

    const { data, error } = await supabase
      .from('users_profiles')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error updating employee:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployeeDocumentationDetails = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { id } = req.params;

    // 1. Get current position for the user
    const { data: currentPos, error: posError } = await supabase
      .from('hr_employee_positions')
      .select('position_id')
      .eq('user_id', id)
      .is('end_date', null)
      .maybeSingle();

    if (posError) throw posError;

    let requiredDocs: any[] = [];
    if (currentPos && currentPos.position_id) {
      // 2. Fetch document types required for the position
      const { data: posDocs, error: posDocsError } = await supabase
        .from('hr_position_document_types')
        .select(`
          mandatory,
          document_type_id,
          hr_document_types(id, name, description)
        `)
        .eq('position_id', currentPos.position_id);

      if (posDocsError) throw posDocsError;

      requiredDocs = posDocs.map((pd: any) => ({
        id: pd.hr_document_types?.id,
        name: pd.hr_document_types?.name,
        description: pd.hr_document_types?.description,
        mandatory: pd.mandatory
      }));
    }

    // 3. Fetch uploaded documents for the user
    const { data: uploadedDocsData, error: uploadedError } = await supabase
      .from('hr_employee_documents')
      .select(`
        id,
        document_type_id,
        file_url,
        status,
        expiry_date,
        created_at,
        hr_document_types(name)
      `)
      .eq('user_id', id)
      .order('created_at', { ascending: false });

    if (uploadedError) throw uploadedError;

    const uploadedDocs = uploadedDocsData.map((doc: any) => ({
      id: doc.id,
      document_type_id: doc.document_type_id,
      type_name: doc.hr_document_types?.name || 'Desconhecido',
      file_url: doc.file_url,
      status: doc.status || 'Pendente',
      expiry_date: doc.expiry_date,
      created_at: doc.created_at
    }));

    // 4. Mark which required docs are uploaded
    const uploadedTypeIds = new Set(uploadedDocs.map(d => d.document_type_id));
    const checklist = requiredDocs.map(reqDoc => ({
      ...reqDoc,
      uploaded: uploadedTypeIds.has(reqDoc.id)
    }));

    res.json({
      checklist,
      uploadedDocs
    });

  } catch (error: any) {
    console.error('Error fetching employee documentation details:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getRecentActivities = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: activities, error } = await supabase
      .from('hr_employee_positions')
      .select('id, start_date, created_at, change_reason, users_profiles!hr_employee_positions_user_id_fkey(full_name), hr_positions(title), hr_job_levels(name)')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    const formattedActivities = activities.map((activity: any) => ({
      id: activity.id,
      employeeName: activity.users_profiles?.full_name || 'Usuário Desconhecido',
      positionTitle: activity.hr_positions?.title || 'Cargo Desconhecido',
      levelName: activity.hr_job_levels?.name || '',
      date: activity.start_date,
      reason: activity.change_reason || 'Nova Atribuição'
    }));

    res.json(formattedActivities);
  } catch (error: any) {
    console.error('Error fetching HR recent activities:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getPositionHistory = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: allHistory, error } = await supabase
      .from('hr_employee_positions')
      .select('id, user_id, start_date, change_reason, users_profiles!hr_employee_positions_user_id_fkey(full_name), hr_positions(title), hr_job_levels(name)')
      .order('start_date', { ascending: true });

    if (error) throw error;

    const historyByUser: Record<string, any[]> = {};

    allHistory.forEach((record: any) => {
      const userId = record.user_id;
      if (!historyByUser[userId]) {
        historyByUser[userId] = [];
      }
      historyByUser[userId].push(record);
    });

    const formattedHistory: any[] = [];

    for (const userId in historyByUser) {
      const userRecords = historyByUser[userId];
      for (let i = 0; i < userRecords.length; i++) {
        const current = userRecords[i];

        let oldPos = '-';
        if (i > 0) {
          const prev = userRecords[i - 1];
          oldPos = `${prev.hr_positions?.title || ''} ${prev.hr_job_levels?.name ? `- ${prev.hr_job_levels.name}` : ''}`.trim();
        }

        const newPos = `${current.hr_positions?.title || ''} ${current.hr_job_levels?.name ? `- ${current.hr_job_levels.name}` : ''}`.trim();

        formattedHistory.push({
          id: current.id,
          employee: current.users_profiles?.full_name || 'Desconhecido',
          oldPos: oldPos,
          newPos: newPos,
          date: current.start_date,
          type: current.change_reason || 'Nova Atribuição',
        });
      }
    }

    formattedHistory.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json(formattedHistory);
  } catch (error: any) {
    console.error('Error fetching HR position history:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getDocumentTypes = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_document_types')
      .select('*')
      .order('name');

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching HR document types:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createDocumentType = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { name, description, requires_expiry, alert_days_before, mandatory, active } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const { data, error } = await supabase
      .from('hr_document_types')
      .insert([
        {
          name,
          description,
          requires_expiry,
          alert_days_before,
          mandatory,
          active
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (error: any) {
    console.error('Error creating HR document type:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const updateDocumentType = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { name, description, requires_expiry, alert_days_before, mandatory, active } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const { data, error } = await supabase
      .from('hr_document_types')
      .update({
        name,
        description,
        requires_expiry,
        alert_days_before,
        mandatory,
        active,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error updating HR document type:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createPosition = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { title, department, cbo_code, description, salaryRanges, documentTypes } = req.body;

    if (!title || !department) {
      return res.status(400).json({ error: 'Title and department are required' });
    }

    // 1. Insert position
    const { data: positionData, error: positionError } = await supabase
      .from('hr_positions')
      .insert([{ title, department, cbo_code, description }])
      .select('id')
      .single();

    if (positionError) throw positionError;
    const positionId = positionData.id;

    // 2. Insert salary ranges if provided
    if (salaryRanges && salaryRanges.length > 0) {
      const rangesToInsert = salaryRanges.map((range: any) => ({
        position_id: positionId,
        level_id: range.level_id,
        salary_min: range.salary_min || 0,
        salary_mid: range.salary_mid || null,
        salary_max: range.salary_max || 0,
        effective_date: new Date().toISOString().split('T')[0], // Today's date
      }));

      const { error: rangesError } = await supabase
        .from('hr_salary_ranges')
        .insert(rangesToInsert);

      if (rangesError) throw rangesError;
    }

    // 3. Insert document types if provided
    if (documentTypes && documentTypes.length > 0) {
      const docsToInsert = documentTypes.map((doc: any) => ({
        position_id: positionId,
        document_type_id: doc.document_type_id,
        mandatory: doc.mandatory !== undefined ? doc.mandatory : true,
      }));

      const { error: docsError } = await supabase
        .from('hr_position_document_types')
        .insert(docsToInsert);

      if (docsError) throw docsError;
    }

    res.status(201).json({ id: positionId, message: 'Position created successfully' });
  } catch (error: any) {
    console.error('Error creating HR position:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getPositionById = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    // 1. Get position basic data
    const { data: position, error: posError } = await supabase
      .from('hr_positions')
      .select('*')
      .eq('id', id)
      .single();

    if (posError) throw posError;

    // 2. Get salary ranges with level info
    const { data: ranges, error: rangesError } = await supabase
      .from('hr_salary_ranges')
      .select('id, level_id, salary_min, salary_mid, salary_max, effective_date, hr_job_levels(id, name)')
      .eq('position_id', id);

    if (rangesError) throw rangesError;

    // 3. Get associated document types
    const { data: docAssocs, error: docsError } = await supabase
      .from('hr_position_document_types')
      .select('id, document_type_id, mandatory')
      .eq('position_id', id);

    if (docsError) throw docsError;

    res.json({
      ...position,
      salaryRanges: ranges,
      documentTypes: docAssocs,
    });
  } catch (error: any) {
    console.error('Error fetching HR position by ID:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const updatePosition = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { title, department, cbo_code, description, salaryRanges, documentTypes } = req.body;

    if (!title || !department) {
      return res.status(400).json({ error: 'Title and department are required' });
    }

    // 1. Update position basic data
    const { error: posError } = await supabase
      .from('hr_positions')
      .update({ title, department, cbo_code, description, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (posError) throw posError;

    // 2. Replace salary ranges: delete old, insert new
    const { error: delRangesError } = await supabase
      .from('hr_salary_ranges')
      .delete()
      .eq('position_id', id);

    if (delRangesError) throw delRangesError;

    if (salaryRanges && salaryRanges.length > 0) {
      const rangesToInsert = salaryRanges.map((range: any) => ({
        position_id: id,
        level_id: range.level_id,
        salary_min: range.salary_min || 0,
        salary_mid: range.salary_mid || null,
        salary_max: range.salary_max || 0,
        effective_date: new Date().toISOString().split('T')[0],
      }));

      const { error: insertRangesError } = await supabase
        .from('hr_salary_ranges')
        .insert(rangesToInsert);

      if (insertRangesError) throw insertRangesError;
    }

    // 3. Replace document type associations: delete old, insert new
    const { error: delDocsError } = await supabase
      .from('hr_position_document_types')
      .delete()
      .eq('position_id', id);

    if (delDocsError) throw delDocsError;

    if (documentTypes && documentTypes.length > 0) {
      const docsToInsert = documentTypes.map((doc: any) => ({
        position_id: id,
        document_type_id: doc.document_type_id,
        mandatory: doc.mandatory !== undefined ? doc.mandatory : true,
      }));

      const { error: insertDocsError } = await supabase
        .from('hr_position_document_types')
        .insert(docsToInsert);

      if (insertDocsError) throw insertDocsError;
    }

    res.json({ id, message: 'Position updated successfully' });
  } catch (error: any) {
    console.error('Error updating HR position:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const changeEmployeePosition = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: { user: authUser } } = await supabase.auth.getUser();

    const { user_id, position_id, level_id, salary, change_reason } = req.body;

    if (!user_id || !position_id || !level_id || !salary || !change_reason) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const today = new Date().toISOString().split('T')[0];

    // 1. Finaliza a posição atual
    const { error: updateError } = await supabase
      .from('hr_employee_positions')
      .update({ end_date: today, updated_at: new Date().toISOString() })
      .eq('user_id', user_id)
      .is('end_date', null);

    if (updateError) throw updateError;

    // 2. Insere a nova posição
    const { error: insertError } = await supabase
      .from('hr_employee_positions')
      .insert([{
        user_id,
        position_id,
        level_id,
        salary: parseFloat(salary) || 0,
        start_date: today,
        change_reason,
        registered_by: authUser?.id || null
      }]);

    if (insertError) throw insertError;

    // 3. Atualizar role_title no users_profiles
    const { data: posData } = await supabase.from('hr_positions').select('title').eq('id', position_id).single();
    if (posData) {
      await supabase.from('users_profiles').update({ role_title: posData.title }).eq('id', user_id);
    }

    res.json({ message: 'Position changed successfully' });
  } catch (error: any) {
    console.error('Error changing employee position:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployeeDocuments = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: docs, error } = await supabase
      .from('hr_employee_documents')
      .select(`
        id,
        expiry_date,
        status,
        file_url,
        users_profiles!hr_employee_documents_user_id_fkey(full_name),
        hr_document_types(name)
      `)
      .order('created_at', { ascending: false })
      .returns<any[]>();

    if (error) throw error;

    // Process data to match frontend expectations
    const formattedDocs = docs.map((doc: any) => ({
      id: doc.id,
      employee: doc.users_profiles?.full_name || 'Desconhecido',
      type: doc.hr_document_types?.name || 'Desconhecido',
      expiry: doc.expiry_date ? new Date(doc.expiry_date).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '-',
      status: doc.status || 'Pendente',
      file_url: doc.file_url || null,
    }));

    res.json(formattedDocs);
  } catch (error: any) {
    console.error('Error fetching employee documents:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createEmployeeDocument = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: { user: authUser } } = await supabase.auth.getUser();

    const { user_id, document_type_id, document_number, issue_date, expiry_date, status, file_url, notes } = req.body;

    if (!user_id || !document_type_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data: newDoc, error } = await supabase
      .from('hr_employee_documents')
      .insert([{
        user_id,
        document_type_id,
        document_number: document_number || null,
        issue_date: issue_date || null,
        expiry_date: expiry_date || null,
        status: status || 'Válido',
        file_url: file_url || null,
        notes: notes || null,
        registered_by: authUser?.id || null,
      }])
      .select()
      .single();

    if (error) throw error;

    res.json(newDoc);
  } catch (error: any) {
    console.error('Error creating employee document:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

// ============================================================
// FOLHA DE PONTO
// ============================================================

export const getEmployeeTimesheets = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { data, error } = await supabase
      .from('hr_timesheet_reports')
      .select(`
        id, period_start, period_end, total_days_worked, total_hours_worked,
        total_overtime_hours, total_absence_days, status, file_url, notes, created_at, approved_at,
        generated_by_profile:users_profiles!hr_timesheet_reports_generated_by_fkey(full_name),
        approved_by_profile:users_profiles!hr_timesheet_reports_approved_by_fkey(full_name)
      `)
      .eq('user_id', id)
      .order('period_start', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching timesheets:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createTimesheetReport = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: authUser } = await supabase.auth.getUser();
    const generatorId = authUser?.user?.id;

    // Verify generator has RH or Admin access
    const { data: generatorProfile } = await supabase
      .from('users_profiles')
      .select('access_level')
      .eq('id', generatorId)
      .single();

    if (!generatorProfile || !['Administrador', 'Gerente', 'Recursos Humanos'].includes(generatorProfile.access_level)) {
      return res.status(403).json({ error: 'Acesso não autorizado para gerar folha de ponto.' });
    }

    const { id } = req.params; // employee user_id
    const { period_start, period_end, notes } = req.body;

    if (!period_start || !period_end) {
      return res.status(400).json({ error: 'period_start e period_end são obrigatórios.' });
    }

    // Fetch all time records in the period for this employee
    const { data: records, error: recError } = await supabase
      .from('hr_time_records')
      .select('record_type, recorded_at, record_date')
      .eq('user_id', id)
      .gte('record_date', period_start)
      .lte('record_date', period_end)
      .order('recorded_at', { ascending: true });

    if (recError) throw recError;

    // Group by date
    const byDate: Record<string, any[]> = {};
    (records || []).forEach((r: any) => {
      if (!byDate[r.record_date]) byDate[r.record_date] = [];
      byDate[r.record_date].push(r);
    });

    // Calculate totals
    let totalDaysWorked = 0;
    let totalHoursWorked = 0;
    let totalOvertime = 0;

    for (const date of Object.keys(byDate)) {
      const dayRecs = byDate[date];
      const entrada = dayRecs.find((r: any) => r.record_type === 'Entrada');
      const saida = dayRecs.find((r: any) => r.record_type === 'Saída');
      const saidaAlmoco = dayRecs.find((r: any) => r.record_type === 'Saída Almoço');
      const retornoAlmoco = dayRecs.find((r: any) => r.record_type === 'Retorno Almoço');

      if (entrada && saida) {
        totalDaysWorked++;
        const entradaMs = new Date(entrada.recorded_at).getTime();
        const saidaMs = new Date(saida.recorded_at).getTime();
        let workedMs = saidaMs - entradaMs;

        if (saidaAlmoco && retornoAlmoco) {
          const almocoMs = new Date(retornoAlmoco.recorded_at).getTime() - new Date(saidaAlmoco.recorded_at).getTime();
          workedMs -= almocoMs;
        }

        const workedHours = workedMs / 3600000;
        totalHoursWorked += workedHours;
        // Standard day = 8h; overtime if > 8h
        if (workedHours > 8) totalOvertime += (workedHours - 8);
      }
    }

    // Count business days in period without records as absences
    const start = new Date(period_start + 'T00:00:00');
    const end = new Date(period_end + 'T00:00:00');
    let businessDays = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) businessDays++;
    }
    const totalAbsences = Math.max(0, businessDays - totalDaysWorked);

    const { data: newReport, error: insertError } = await supabase
      .from('hr_timesheet_reports')
      .insert([{
        user_id: id,
        period_start,
        period_end,
        total_days_worked: totalDaysWorked,
        total_hours_worked: parseFloat(totalHoursWorked.toFixed(2)),
        total_overtime_hours: parseFloat(totalOvertime.toFixed(2)),
        total_absence_days: totalAbsences,
        status: 'Gerada',
        notes: notes || null,
        generated_by: generatorId,
      }])
      .select()
      .single();

    if (insertError) throw insertError;

    res.status(201).json(newReport);
  } catch (error: any) {
    console.error('Error creating timesheet report:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Já existe uma folha de ponto para este colaborador neste período.' });
    }
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const updateTimesheetStatus = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: authUser } = await supabase.auth.getUser();
    const userId = authUser?.user?.id;

    const { timesheetId } = req.params;
    const { status, notes } = req.body;

    if (!['Aprovada', 'Contestada'].includes(status)) {
      return res.status(400).json({ error: 'Status deve ser "Aprovada" ou "Contestada".' });
    }

    // Fetch the timesheet to verify ownership
    const { data: ts, error: fetchErr } = await supabase
      .from('hr_timesheet_reports')
      .select('user_id, status')
      .eq('id', timesheetId)
      .single();

    if (fetchErr || !ts) return res.status(404).json({ error: 'Folha de ponto não encontrada.' });
    if (ts.user_id !== userId) return res.status(403).json({ error: 'Apenas o próprio colaborador pode aprovar ou contestar sua folha.' });
    if (ts.status !== 'Gerada') return res.status(400).json({ error: 'Apenas folhas com status "Gerada" podem ser atualizadas.' });

    const updatePayload: any = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (status === 'Aprovada') {
      updatePayload.approved_by = userId;
      updatePayload.approved_at = new Date().toISOString();
    }
    if (notes) updatePayload.notes = notes;

    const { data: updated, error: updateErr } = await supabase
      .from('hr_timesheet_reports')
      .update(updatePayload)
      .eq('id', timesheetId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.json(updated);
  } catch (error: any) {
    console.error('Error updating timesheet status:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployeeTimeRecords = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;
    const { month, year } = req.query;

    let query = supabase
      .from('hr_time_records')
      .select(`id, record_type, recorded_at, record_date, origin, justification,
        adjusted_by_profile:users_profiles!hr_time_records_adjusted_by_fkey(full_name)`)
      .eq('user_id', id)
      .order('recorded_at', { ascending: true });

    if (month && year) {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = new Date(Number(year), Number(month), 0).toISOString().split('T')[0];
      query = query.gte('record_date', startDate).lte('record_date', endDate);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching time records:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

// ============================================================
// FÉRIAS
// ============================================================

export const getEmployeeVacationRequests = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { data, error } = await supabase
      .from('hr_vacation_requests')
      .select(`
        id, entitlement_period_start, entitlement_period_end,
        total_entitled_days, installments_count, days_sold,
        total_days_requested, status, rejection_reason, notes, created_at, updated_at,
        installments:hr_vacation_installments(
          id, installment_number, start_date, end_date, duration_days
        ),
        approvals:hr_vacation_approvals(
          id, status, decided_at,
          approver:users_profiles!hr_vacation_approvals_approver_id_fkey(full_name)
        )
      `)
      .eq('user_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching vacation requests:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createVacationRequest = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const {
      user_id, entitlement_period_start, entitlement_period_end,
      total_entitled_days, installments_count, days_sold,
      total_days_requested, notes, installments
    } = req.body;

    // Insert vacation request
    const { data: newRequest, error: reqError } = await supabase
      .from('hr_vacation_requests')
      .insert([{
        user_id, entitlement_period_start, entitlement_period_end,
        total_entitled_days: total_entitled_days || 30,
        installments_count, days_sold: days_sold || 0,
        total_days_requested, notes: notes || null,
      }])
      .select()
      .single();

    if (reqError) throw reqError;

    // Insert installments
    if (installments && installments.length > 0) {
      const installmentRows = installments.map((inst: any, idx: number) => ({
        vacation_request_id: newRequest.id,
        installment_number: idx + 1,
        start_date: inst.start_date,
        end_date: inst.end_date,
        duration_days: inst.duration_days,
      }));
      const { error: instError } = await supabase.from('hr_vacation_installments').insert(installmentRows);
      if (instError) throw instError;
    }

    // Create approvals for all active Gerentes and Admins
    const { data: approvers, error: approversError } = await supabase
      .from('users_profiles')
      .select('id')
      .in('access_level', ['Administrador', 'Gerente', 'Recursos Humanos'])
      .eq('active', true);

    if (approversError) throw approversError;

    if (approvers && approvers.length > 0) {
      const approvalRows = approvers.map((ap: any) => ({
        vacation_request_id: newRequest.id,
        approver_id: ap.id,
      }));
      const { error: apprError } = await supabase.from('hr_vacation_approvals').insert(approvalRows);
      if (apprError) throw apprError;
    }

    res.status(201).json(newRequest);
  } catch (error: any) {
    console.error('Error creating vacation request:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

// ============================================================
// EPI
// ============================================================

export const getEpiCatalog = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_epi_catalog')
      .select('*')
      .eq('active', true)
      .order('name');

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching EPI catalog:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployeeEpiRecords = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);
    const { id } = req.params;

    const { data, error } = await supabase
      .from('hr_epi_records')
      .select(`
        id, delivery_date, file_url, file_uploaded_at, notes, created_at,
        uploaded_by_profile:users_profiles!hr_epi_records_uploaded_by_fkey(full_name),
        items:hr_epi_record_items(
          id, quantity, notes,
          epi:hr_epi_catalog(id, name, ca_number)
        )
      `)
      .eq('user_id', id)
      .order('delivery_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching EPI records:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createEpiRecord = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: authUser } = await supabase.auth.getUser();
    const { id } = req.params; // user_id (employee)
    const { delivery_date, file_url, notes, items } = req.body;

    if (!delivery_date || !file_url) {
      return res.status(400).json({ error: 'delivery_date and file_url are required' });
    }

    const { data: newRecord, error: recordError } = await supabase
      .from('hr_epi_records')
      .insert([{
        user_id: id,
        delivery_date,
        file_url,
        uploaded_by: authUser?.user?.id,
        notes: notes || null,
      }])
      .select()
      .single();

    if (recordError) throw recordError;

    if (items && items.length > 0) {
      const itemRows = items.map((item: any) => ({
        epi_record_id: newRecord.id,
        epi_id: item.epi_id,
        quantity: item.quantity || 1,
        notes: item.notes || null,
      }));
      const { error: itemsError } = await supabase.from('hr_epi_record_items').insert(itemRows);
      if (itemsError) throw itemsError;
    }

    res.status(201).json(newRecord);
  } catch (error: any) {
    console.error('Error creating EPI record:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

// ============================================================
// CLOCK-IN (Batida de ponto do próprio usuário)
// ============================================================

const RECORD_TYPE_SEQUENCE = ['Entrada', 'Saída Almoço', 'Retorno Almoço', 'Saída'];

export const getMyTodayRecords = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: user } = await supabase.auth.getUser();
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('hr_time_records')
      .select('id, record_type, recorded_at, origin')
      .eq('user_id', user.user?.id)
      .eq('record_date', today)
      .order('recorded_at', { ascending: true });

    if (error) throw error;

    // Determine next expected record type
    const lastType = data && data.length > 0 ? data[data.length - 1].record_type : null;
    const lastIdx = lastType ? RECORD_TYPE_SEQUENCE.indexOf(lastType) : -1;
    const nextType = lastIdx < RECORD_TYPE_SEQUENCE.length - 1
      ? RECORD_TYPE_SEQUENCE[lastIdx + 1]
      : null; // all done

    res.json({ records: data, nextType });
  } catch (error: any) {
    console.error('Error fetching today records:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const clockIn = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const today = new Date().toISOString().split('T')[0];

    // Get today's records to infer the next type
    const { data: todayRecords, error: fetchError } = await supabase
      .from('hr_time_records')
      .select('record_type, recorded_at')
      .eq('user_id', userId)
      .eq('record_date', today)
      .order('recorded_at', { ascending: true });

    if (fetchError) throw fetchError;

    const lastType = todayRecords && todayRecords.length > 0
      ? todayRecords[todayRecords.length - 1].record_type
      : null;
    const lastIdx = lastType ? RECORD_TYPE_SEQUENCE.indexOf(lastType) : -1;
    const nextType = RECORD_TYPE_SEQUENCE[lastIdx + 1];

    if (!nextType) {
      return res.status(400).json({ error: 'Todos os registros do dia já foram realizados.' });
    }

    const now = new Date();
    const { data: newRecord, error: insertError } = await supabase
      .from('hr_time_records')
      .insert([{
        user_id: userId,
        record_type: nextType,
        recorded_at: now.toISOString(),
        record_date: today,
        origin: 'Sistema',
      }])
      .select()
      .single();

    if (insertError) throw insertError;

    res.status(201).json({ record: newRecord, nextType });
  } catch (error: any) {
    console.error('Error clocking in:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

// ==========================================
// TREINAMENTOS (TRAININGS)
// ==========================================

export const getTrainingCatalog = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_training_catalog')
      .select('*')
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    console.error('Error fetching training catalog:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createTrainingCatalog = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_training_catalog')
      .insert([req.body])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error: any) {
    console.error('Error creating training catalog:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const updateTrainingCatalog = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { id } = req.params;

    const { data, error } = await supabase
      .from('hr_training_catalog')
      .update(req.body)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error updating training catalog:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployeeTrainings = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_employee_trainings')
      .select(`
        *,
        hr_training_catalog(name, category),
        users_profiles!user_id(full_name)
      `)
      .order('completion_date', { ascending: false });

    if (error) throw error;

    // Format response to match frontend expectations
    const formattedData = data.map((t: any) => ({
      id: t.id,
      employee: t.users_profiles?.full_name || 'Desconhecido',
      training: t.hr_training_catalog?.name || 'Desconhecido',
      date: new Date(t.completion_date + 'T00:00:00').toLocaleDateString('pt-BR'),
      workload: `${t.workload_hours || 0}h`,
      status: t.status,
      file_url: t.certificate_url
    }));

    res.json(formattedData);
  } catch (error: any) {
    console.error('Error fetching employee trainings:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createEmployeeTraining = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const { data: userObj, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userObj.user) return res.status(401).json({ error: 'Invalid token' });

    const registered_by = userObj.user.id;

    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_employee_trainings')
      .insert([{ ...req.body, registered_by }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error: any) {
    console.error('Error creating employee training:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getTrainingMetrics = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_employee_trainings')
      .select('workload_hours, cost');

    if (error) throw error;

    let totalHours = 0;
    let totalCost = 0;

    if (data) {
      for (const item of data) {
        totalHours += Number(item.workload_hours) || 0;
        totalCost += Number(item.cost) || 0;
      }
    }

    res.json({ totalHours, totalCost });
  } catch (error: any) {
    console.error('Error fetching training metrics:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

// --- INTEGRATIONS ---

export const getIntegrationTypes = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_integration_types')
      .select('*')
      .order('name');

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching integration types:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createIntegrationType = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_integration_types')
      .insert([req.body])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error: any) {
    console.error('Error creating integration type:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const updateIntegrationType = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { id } = req.params;

    const { data, error } = await supabase
      .from('hr_integration_types')
      .update(req.body)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error updating integration type:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getEmployeeIntegrations = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_employee_integrations')
      .select(`
        *,
        employee:user_id ( full_name ),
        integration_type:integration_type_id ( name )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const formattedData = data.map((item: any) => ({
      id: item.id,
      employee: item.employee?.full_name,
      type: item.integration_type?.name,
      client: item.location || 'Não especificado', // Using location instead of client relation for MVP
      date: item.integration_date ? new Date(item.integration_date).toLocaleDateString('pt-BR') : '-',
      expiry: item.expiry_date ? new Date(item.expiry_date).toLocaleDateString('pt-BR') : '-',
      status: item.status,
      file_url: item.file_url
    }));

    res.json(formattedData);
  } catch (error: any) {
    console.error('Error fetching employee integrations:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const createEmployeeIntegration = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const { data: userObj, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userObj.user) return res.status(401).json({ error: 'Invalid token' });

    const registered_by = userObj.user.id;
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_employee_integrations')
      .insert([{ ...req.body, registered_by }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error: any) {
    console.error('Error creating employee integration:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

export const getIntegrationMetrics = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing authorization header' });
    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseUserClient(token);

    const { data, error } = await supabase
      .from('hr_employee_integrations')
      .select('status');

    if (error) throw error;

    let valid = 0;
    let expired = 0;
    let expiring = 0;

    if (data) {
      for (const item of data) {
        if (item.status === 'Válida') valid++;
        else if (item.status === 'Vencida') expired++;
        else if (item.status === 'A Vencer') expiring++;
      }
    }

    res.json({ valid, expired, expiring, total: valid + expired + expiring });
  } catch (error: any) {
    console.error('Error fetching integration metrics:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};
