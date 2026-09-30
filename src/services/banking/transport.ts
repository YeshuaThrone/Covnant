import type { BankingTransport } from "./types";

/**
 * The production transport: plain fetch. Every adapter routes its outbound
 * calls through the injected BankingTransport — tests replace this with a
 * spy, so the sandbox/test run never touches the network.
 */
export const defaultBankingTransport: BankingTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return { status: response.status, body: await response.text() };
};
