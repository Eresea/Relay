import type { LinearProjectRequest } from '@/features/home/home';

/** Placeholder while Linear is ported from Angular. */
export default function Linear(_props: {
  projectRequest: LinearProjectRequest | null;
  onProjectRequestHandled: (request: LinearProjectRequest) => void;
}) {
  return <div className="grid h-full place-items-center text-muted">Not ported yet</div>;
}
