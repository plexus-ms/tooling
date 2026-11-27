import { connection } from 'next/server';

// The route of the compose healthcheck (PLX-App/Healthcheck): check here what the app cannot serve without.
export async function GET() {
  await connection();
  return new Response(null);
}
