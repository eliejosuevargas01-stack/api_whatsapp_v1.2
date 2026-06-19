import fs from "node:fs";
import jwt from "jsonwebtoken";
import path from "node:path";

const privateKey = fs.readFileSync(path.resolve(process.env.JWT_PRIVATE_KEY_PATH), "utf8");
const publicKey = fs.readFileSync(path.resolve(process.env.JWT_PUBLIC_KEY_PATH), "utf8");

export const signM2MToken = (payload, expiresIn = "1h") =>
  jwt.sign(payload, privateKey, { algorithm: "RS256", expiresIn });

export const verifyM2MToken = (token) =>
  jwt.verify(token, publicKey, { algorithms: ["RS256"] });
