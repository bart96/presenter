import { useStageEngine } from '@/hooks/useStageEngine';

/**
 * Hosts the stage engine, for the same reason `PresentationSyncHost` exists: the hook
 * subscribes to layers, runtime position and navigation, and mounting it as a leaf means
 * a cue change re-renders this null component instead of MainPage and its MUI subtree.
 *
 * The engine has to run wherever the operator is, not only while a stage panel happens to
 * be open — a countdown started before the service must keep handing over to the next cue
 * with every panel closed.
 */
const StageEngineHost = () => {
  useStageEngine();
  return null;
};

export default StageEngineHost;
