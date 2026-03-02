import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const publicKeyUrl = `${req.nextUrl.origin}/.well-known/appspecific/com.tesla.3p.public-key.pem`;
  return new Response(`ok ${publicKeyUrl}\n`, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
