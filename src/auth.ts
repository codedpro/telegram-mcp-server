import { Api } from "teleproto";
import { computeCheck } from "teleproto/Password.js";
import { config } from "./config.js";
import { formatUser } from "./format.js";
import { activeAccount, clearSession, listAccounts, markActive, saveAccountMeta, sessionSource } from "./session.js";
import {
  getClient,
  isAuthorized,
  markAuthorized,
  persistSession,
  resetClient,
} from "./telegram.js";

export type Stage = "logged_out" | "code_sent" | "password_needed" | "logged_in";

interface LoginState {
  stage: Stage;
  account?: string;
  phone?: string;
  phoneCodeHash?: string;
  codeVia?: "app" | "sms";
  passwordHint?: string;
}

let state: LoginState = { stage: "logged_out" };

const nextStep: Record<Stage, string> = {
  logged_out: "Ask the user for their phone number (with country code) and call telegram_login_start.",
  code_sent: "Ask the user for the login code Telegram just sent them and call telegram_login_code.",
  password_needed: "Ask the user for their two-step verification password and call telegram_login_password.",
  logged_in: "Logged in. All other telegram_* tools are available.",
};

async function finishLogin() {
  const account = state.account ?? activeAccount();
  markAuthorized(account);
  const file = persistSession(account);
  // ورود، حسابِ تازه را فعال می‌کند؛ ذخیره‌ی نشست دیگر این کار را نمی‌کند.
  markActive(account);
  const me = (await (await getClient(account)).getMe()) as Api.User;
  const user = formatUser(me);
  saveAccountMeta({ name: account, id: user.id, username: user.username, firstName: user.firstName, phone: user.phone });
  state = { stage: "logged_in", account };
  return { stage: state.stage, account, user, sessionSavedTo: file, next: nextStep.logged_in };
}

export async function loginStatus() {
  if (await isAuthorized()) {
    const account = activeAccount();
    state = { stage: "logged_in", account };
    const me = (await (await getClient()).getMe()) as Api.User;
    const user = formatUser(me);
    // Backfill metadata for sessions saved before names existed.
    if (!listAccounts().some((a) => a.name === account && a.id)) {
      saveAccountMeta({ name: account, id: user.id, username: user.username, firstName: user.firstName, phone: user.phone });
    }
    return {
      stage: state.stage,
      account,
      user,
      sessionSource: sessionSource(),
      savedAccounts: listAccounts().map((a) => a.name),
      next: nextStep.logged_in,
    };
  }
  return {
    stage: state.stage,
    account: state.account ?? activeAccount(),
    savedAccounts: listAccounts().map((a) => a.name),
    phone: state.phone,
    codeVia: state.codeVia,
    passwordHint: state.passwordHint,
    sessionSource: sessionSource(),
    next: nextStep[state.stage],
  };
}

export async function loginStart(phone: string, forceSms = false, account?: string) {
  if (!account && (await isAuthorized())) return loginStatus();
  const target = account ?? activeAccount();
  const client = await getClient(target);
  const result = await client.sendCode(
    { apiId: config.apiId, apiHash: config.apiHash },
    phone,
    forceSms,
  );
  state = {
    stage: "code_sent",
    account: target,
    phone,
    phoneCodeHash: result.phoneCodeHash,
    codeVia: result.isCodeViaApp ? "app" : "sms",
  };
  return {
    stage: state.stage,
    account: state.account,
    phone,
    codeVia: state.codeVia,
    next: `${nextStep.code_sent} The code was sent via ${state.codeVia === "app" ? "the Telegram app on another device" : "SMS"}.`,
  };
}

export async function loginCode(code: string) {
  if (state.stage !== "code_sent" || !state.phone || !state.phoneCodeHash) {
    throw new Error(`No login in progress. ${nextStep.logged_out}`);
  }
  const client = await getClient(state.account);
  try {
    const result = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: state.phone,
        phoneCodeHash: state.phoneCodeHash,
        phoneCode: code.replace(/\s+/g, ""),
      }),
    );
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      state = { stage: "logged_out" };
      throw new Error("No Telegram account exists for this phone number. Create one in the official app first.");
    }
    return finishLogin();
  } catch (err) {
    const message = (err as { errorMessage?: string }).errorMessage ?? "";
    if (message === "SESSION_PASSWORD_NEEDED") {
      const password = await client.invoke(new Api.account.GetPassword());
      state = { ...state, stage: "password_needed", passwordHint: password.hint ?? undefined };
      return {
        stage: state.stage,
        passwordHint: state.passwordHint,
        next: `${nextStep.password_needed}${state.passwordHint ? ` Hint: "${state.passwordHint}".` : ""}`,
      };
    }
    if (message === "PHONE_CODE_INVALID") {
      throw new Error("That code is wrong. Ask the user to check it and call telegram_login_code again.");
    }
    if (message === "PHONE_CODE_EXPIRED") {
      state = { stage: "logged_out" };
      throw new Error("That code has expired. Call telegram_login_start again to get a new one.");
    }
    throw err;
  }
}

export async function loginPassword(password: string) {
  if (state.stage !== "password_needed") {
    throw new Error(`Telegram has not asked for a password. ${nextStep[state.stage]}`);
  }
  const client = await getClient(state.account);
  const srp = await client.invoke(new Api.account.GetPassword());
  try {
    await client.invoke(
      new Api.auth.CheckPassword({ password: await computeCheck(srp, password) }),
    );
  } catch (err) {
    const message = (err as { errorMessage?: string }).errorMessage ?? "";
    if (message === "PASSWORD_HASH_INVALID") {
      throw new Error("Wrong two-step verification password. Ask the user to try again.");
    }
    throw err;
  }
  return finishLogin();
}

export async function logout(account?: string) {
  const target = account ?? activeAccount();
  const client = await getClient(target);
  let remote = false;
  try {
    remote = await client.logOut();
  } catch {
    // Session may already be invalid; still clear locally.
  }
  clearSession(target);
  await resetClient(target);
  state = { stage: "logged_out" };
  return {
    stage: state.stage,
    account: target,
    invalidatedOnTelegram: remote,
    remainingAccounts: listAccounts().map((a) => a.name),
    next: nextStep.logged_out,
  };
}
