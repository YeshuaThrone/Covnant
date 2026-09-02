import { getContract } from '@/lib/contracts/store';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const contract = await getContract(id);
  if (!contract) return new Response('Contract not found.', { status: 404 });

  return new Response(contract.document, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${contract.id}-${contract.templateId}.txt"`,
    },
  });
}
