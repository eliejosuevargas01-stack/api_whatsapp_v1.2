import fs from "node:fs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import path from "node:path";

const privateKeyPath = path.resolve(process.env.JWT_PRIVATE_KEY_PATH || "keys/private.key");
const publicKeyPath = path.resolve(process.env.JWT_PUBLIC_KEY_PATH || "keys/public.key");

// Auto-generate RSA key pair if keys don't exist
if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
  const keysDir = path.dirname(privateKeyPath);
  fs.mkdirSync(keysDir, { recursive: true });

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  fs.writeFileSync(privateKeyPath, privateKey, "utf8");
  fs.writeFileSync(publicKeyPath, publicKey, "utf8");
  console.log(`[jwt] RSA key pair generated at ${keysDir}/`);
}

const privateKey = fs.readFileSync(privateKeyPath, "utf8");
const publicKey = fs.readFileSync(publicKeyPath, "utf8");

export const signM2MToken = (payload, expiresIn = "1h") =>
  jwt.sign(payload, privateKey, { algorithm: "RS256", expiresIn });

export const verifyM2MToken = (token) =>
  jwt.verify(token, publicKey, { algorithms: ["RS256"] });
