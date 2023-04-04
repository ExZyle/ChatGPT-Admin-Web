import { redis } from "../redis/client";
import md5 from "spark-md5";
import { generateRandomSixDigitNumber } from "./utils";
import { AccessControlDAL } from "./access_control";
import { Model, Register } from "./typing";

export class UserDAL {
  email: string;

  constructor(email: string) {
    this.email = email.trim().toLowerCase();
  }

  get accessControl(): AccessControlDAL {
    return new AccessControlDAL(this.email);
  }

  get userKey(): string {
    return `user:${this.email}`;
  }

  async get(): Promise<Model.User | null> {
    const user = await redis.hgetall<Model.User>(this.userKey);
    return user;
  }

  async update(data: Partial<Model.User>): Promise<boolean> {
    const userKey = this.userKey;
    return await redis.hmset(userKey, data) === "OK";
  }

  async exists(): Promise<boolean> {
    const user = await this.get();
    return user !== null;
  }

  async delete(): Promise<boolean> {
    return await redis.del(this.userKey) === 1;
  }

  static async fromRegistration(
    email: string,
    password: string,
    name: string | undefined = "Anonymous",
  ): Promise<UserDAL | null> {
    const userDAL = new UserDAL(email);

    if (await userDAL.exists()) return null;

    await userDAL.update({
      name,
      passwordHash: md5.hash(password.trim()),
      phone: null,
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      isBlocked: false,
    });

    return userDAL;
  }

  async login(password: string): Promise<boolean> {
    const user = await this.get();
    const isSuccess = user?.passwordHash === md5.hash(password.trim());

    if (isSuccess) {
      // Set last login
      await this.update({ lastLoginAt: Date.now() });
    }
    return isSuccess;
  }

  /**
   * 请求(邮箱|手机)激活码, 速率请求由 Cloudflare 规则限制
   * @param codeType Email or Phone
   * @param phone if Phone type, phone number is required
   * @return {
   *   status:
   *   code: register code
   *   ttl:  ttl of the (exist) code
   * }
   */
  async newRegisterCode(
    codeType: Register.CodeType,
    phone?: string,
  ): Promise<{
    status: Register.ReturnStatus;
    code?: number;
    ttl?: number;
  }> {
    if (codeType === "phone") {
      if (!phone) throw new Error("Phone number is required");

      // The following code is not possible in Redis

      // if (someUser.hasSamePhone) {
      //   return { status: Register.ReturnStatus.AlreadyRegister };
      // }
    }

    const key = `register:code:${codeType}:${phone ?? this.email}`;
    const code = await redis.get<number>(key);

    if (code) {
      const ttl = await redis.ttl(key);
      if (ttl >= 240) return { status: Register.ReturnStatus.TooFast, ttl };
    }

    const randomNumber = generateRandomSixDigitNumber();
    if ((await redis.set(key, randomNumber)) === "OK") {
      await redis.expire(key, 60 * 5); // Expiration time: 5 minutes
      return {
        status: Register.ReturnStatus.Success,
        code: randomNumber,
        ttl: 300,
      };
    }

    return { status: Register.ReturnStatus.UnknownError };
  }

  /**
   * 激活激活码, 手机号则进入数据库
   * @param code
   * @param codeType
   * @param phone
   */
  async activateRegisterCode(
    code: string | number,
    codeType: Register.CodeType,
    phone?: string,
  ): Promise<boolean> {
    if (codeType === "phone" && !phone) {
      throw new Error("Phone number is required");
    }
    const key = `register:code:${codeType}:${phone ?? this.email}`;
    const remoteCode = await redis.get(key);

    const isSuccess = remoteCode == code;

    if (isSuccess) {
      const delKey = redis.del(key);
      const storePhone = this.update({ phone });

      await Promise.all([delKey, storePhone]);
    }

    return isSuccess;
  }
}