export async function GET(request) {
  const secret = request.headers.get('x-wm-secret');
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  const TOKEN = process.env.APPS_SCRIPT_TOKEN;

  try {
    const res = await fetch(
      `${APPS_SCRIPT_URL}?token=${TOKEN}`,
      { next: { revalidate: 60 } }
    );
    const data = await res.json();
    return Response.json(data);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}