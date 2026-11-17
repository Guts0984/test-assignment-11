import { TrackPage } from '@/pages/track';

export default async function Route({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <TrackPage token={token} />;
}
