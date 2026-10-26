export type TrainingLevel = 'Iniciante' | 'Intermediário' | 'Avançado';
export type TrainingStatus = 'Pendente' | 'Em Andamento' | 'Concluído' | 'Vencido';

export interface TrainingCategory {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  active: boolean;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TrainingTopicCatalog {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TrainingTopic {
  id: string;
  training_id: string;
  topic_id: string;
  position: number;
  start_seconds: number;
  end_seconds?: number | null;
  description?: string | null;
  topic?: TrainingTopicCatalog;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TrainingAssignment {
  id: string;
  training_id: string;
  user_id: string;
  status: 'Pendente' | 'Em Andamento' | 'Concluído';
  derived_status?: TrainingStatus;
  due_date?: string | null;
  progress_pct: number;
  last_position_seconds: number;
  max_position_seconds: number;
  started_at?: string | null;
  completed_at?: string | null;
  last_accessed_at?: string | null;
  notes?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
  user?: {
    id: string;
    full_name: string;
    email: string;
    access_level?: string;
    photo_url?: string | null;
    role_title?: string | null;
  };
  training?: Training;
}

export interface Training {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  category_id: string;
  level: TrainingLevel;
  youtube_url: string;
  youtube_video_id?: string | null;
  duration_seconds: number;
  instructor_name?: string | null;
  objectives: string[];
  is_mandatory: boolean;
  default_due_days?: number | null;
  active: boolean;
  created_by: string;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
  category?: TrainingCategory;
  creator?: {
    id: string;
    full_name: string;
    email: string;
    role_title?: string | null;
    photo_url?: string | null;
  } | null;
  topics?: TrainingTopic[];
  assignments?: TrainingAssignment[];
  my_assignment?: TrainingAssignment | null;
  can_delete?: boolean;
}

export interface CreateTrainingDTO {
  title: string;
  subtitle?: string;
  description?: string;
  category_id: string;
  level?: TrainingLevel;
  youtube_url: string;
  duration_seconds: number;
  instructor_name?: string;
  objectives?: string[];
  is_mandatory?: boolean;
  default_due_days?: number;
  topics?: Array<{
    topic_id?: string;
    topic_name?: string;
    position?: number;
    start_seconds: number;
    end_seconds?: number;
    description?: string;
  }>;
}

export interface AssignTrainingDTO {
  user_ids: string[];
  due_date?: string;
  notes?: string;
}

export interface UpdateProgressDTO {
  position_seconds: number;
}
