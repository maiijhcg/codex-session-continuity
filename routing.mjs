import path from 'node:path';
import {readSessionLocation} from './session-location.mjs';

export class RoutingError extends Error {
  constructor(message, code = 'ROUTE_MISMATCH') { super(message); this.name = 'RoutingError'; this.code = code; }
}

// Never resolve an empty/relative path against the controller's own working directory.
export function normalizedDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(value);
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(value)) return null;
  const normalized = paths.normalize(value);
  const root = paths.parse(normalized).root;
  const result = normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
  return windows ? result.toLowerCase() : result;
}

export function resolveContinuationTarget(session, projects, sourceThread = {}) {
  let effectiveCwd=session.cwd,locationEvidence=null;
  let cwd = normalizedDirectory(effectiveCwd);
  if (!cwd) throw new RoutingError('原任務缺少有效的絕對工作目錄，已保留交接並停止建立。');
  if (sourceThread.hostId && sourceThread.hostId !== 'local') {
    throw new RoutingError('原任務不在本機；本接續程式不會將遠端任務改到本機。');
  }
  if (sourceThread.cwd && normalizedDirectory(sourceThread.cwd) !== cwd) {
    const latest=readSessionLocation(session);
    if(sourceThread.hostId!=='local'||!latest||normalizedDirectory(latest.cwd)!==normalizedDirectory(sourceThread.cwd))
      throw new RoutingError('桌面回報的原工作目錄與已保存紀錄不一致，且無一致的最新實際執行紀錄；請先核對原任務位置。');
    effectiveCwd=latest.cwd;cwd=normalizedDirectory(effectiveCwd);locationEvidence=latest;
  }
  const local = projects.filter(p => p.hostId === 'local' || (!p.hostId && p.projectKind === 'local'));
  let project;
  if (sourceThread.projectId) {
    project = local.find(p => p.projectId === sourceThread.projectId);
    if (!project) throw new RoutingError('原專案已不在本機已儲存專案清單，已停止建立；不會轉到預設專案。');
    if (normalizedDirectory(project.path) !== cwd) {
      throw new RoutingError('原任務位於子目錄、worktree 或專案位置已變更；目前介面不能在該專案指定原 cwd，已停止建立。');
    }
  } else {
    const matches = local.filter(p => normalizedDirectory(p.path) === cwd);
    if (matches.length !== 1) throw new RoutingError(matches.length
      ? '多個專案對應原工作目錄，無法唯一確認原專案，已停止建立。'
      : '沒有已儲存的本機專案精確對應原工作目錄，已停止建立；不會使用 projectless 或預設專案。');
    [project] = matches;
  }
  if (!project.projectId) throw new RoutingError('原專案缺少 projectId，已停止建立。');
  return {
    // The user explicitly requires the existing directory and uncommitted files.
    target: {type: 'project', projectId: project.projectId, environment: {type: 'local'}},
    projectId: project.projectId,
    projectLabel: project.label || project.projectId,
    projectPath: project.path,
    cwd: effectiveCwd,
    ...(locationEvidence?{sourceLocationEvidence:locationEvidence}:{}),
    hostId: 'local',
    sourceThreadId: session.id,
    sourceTitle: sourceThread.title || '',
    isGitRepository: Boolean(project.isGitRepository),
  };
}

export function threadIsIdle(thread) {
  const status = typeof thread?.status === 'string' ? thread.status : thread?.status?.type;
  return status === 'idle' || status === 'notLoaded';
}

export function verifySuccessorLocation(thread, route) {
  if (!thread || !normalizedDirectory(thread.cwd)) throw new RoutingError('新任務尚未回報工作目錄，等待核對。','ROUTE_PENDING');
  if (!thread.projectId || !thread.hostId) throw new RoutingError('新任務尚未回報專案或 host，等待完整位置資料。','ROUTE_PENDING');
  if (normalizedDirectory(thread.cwd) !== normalizedDirectory(route.cwd)) {
    throw new RoutingError('新任務工作目錄與原任務不一致，未標記接續成功；禁止重送建立。');
  }
  if (thread.hostId && thread.hostId !== route.hostId) throw new RoutingError('新任務 host 不符原 host。');
  if (thread.projectId && thread.projectId !== route.projectId) throw new RoutingError('新任務專案不符原專案。');
  return true;
}

// read_thread currently returns live cwd/host but may omit projectId for a
// task absent from the UI snapshot. Verify its actual location against one
// unambiguous saved project; record this evidence separately from a reported ID.
export function verifySuccessorWithProjects(thread, route, projects) {
  if (thread?.projectId) {
    verifySuccessorLocation(thread,route);
    return {method:'desktop_project_id',projectId:thread.projectId,cwd:thread.cwd,hostId:thread.hostId};
  }
  if (!thread?.hostId || !normalizedDirectory(thread.cwd))
    throw new RoutingError('新任務尚未回報實際 cwd／host，等待完整位置資料。','ROUTE_PENDING');
  if (thread.hostId !== route.hostId || normalizedDirectory(thread.cwd) !== normalizedDirectory(route.cwd))
    throw new RoutingError('新任務的實際 cwd／host 不符原位置，禁止重送建立。');
  const matches=(projects || []).filter(p=>(p.hostId==='local'||(!p.hostId&&p.projectKind==='local'))
    &&normalizedDirectory(p.path)===normalizedDirectory(thread.cwd));
  if(matches.length!==1 || !matches[0].projectId)
    throw new RoutingError('新任務 cwd 無法唯一對應目前已儲存的本機專案，等待核對。','ROUTE_PENDING');
  verifySuccessorLocation({...thread,projectId:matches[0].projectId},route);
  return {method:'unique_saved_project_cwd',projectId:matches[0].projectId,cwd:thread.cwd,hostId:thread.hostId,
    projectIdReported:false};
}
