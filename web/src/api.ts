export type Product = { id: number; name: string; pricePaise: number; stock: number; available: number };

export type OrderStatus = 'pending' | 'paid' | 'picked_up' | 'expired' | 'needs_review';

export type Order = {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  expiresInSeconds: number;
  reviewReason: string | null;
  items: { productId: number; name: string; quantity: number; unitPricePaise: number }[];
};

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error?.code ?? 'http_error', data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

export const getProducts = () => call<{ products: Product[] }>('GET', '/products').then((r) => r.products);
export const placeOrder = (items: { productId: number; quantity: number }[]) => call<Order>('POST', '/orders', { items });
export const getOrder = (id: string) => call<Order>('GET', `/orders/${id}`);

/** Integer paise to a rupee string, without floating-point arithmetic. */
export function rupees(paise: number): string {
  return `₹${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}
