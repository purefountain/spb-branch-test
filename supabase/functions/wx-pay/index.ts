import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

// 商户配置从环境变量读取（denv）
const MERCHANT_ID = Deno.env.get("MERCHANT_ID") ?? "1726450035";
const MERCHANT_APP_ID = Deno.env.get("MERCHANT_APP_ID") ?? "wx6b342a65e745aa1f";
const MCH_CERT_SERIAL_NO = Deno.env.get("MCH_CERT_SERIAL_NO") ?? "7499A957D6479FEEEFE693E20C6BF07BF418AC09";
const MCH_APIV3_KEY = Deno.env.get("MCH_API_V3_KEY") ?? "h2Fv7N8jLk3Wp2Z9sR1QdU6V5XyA4B00";
const MCH_PRIVATE_KEY = Deno.env.get("MCH_PRIVATE_KEY") ?? ""; // PKCS8 PEM

// 支付类型枚举
enum PaymentType {
  NATIVE = 'native'    // 扫码支付
}

// 请求参数接口
interface CreatePaymentRequest {
  out_trade_no: string;
  notify_url?: string;
  payment_type?: PaymentType;
}

// 响应接口
interface CreatePaymentResponse {
  success: boolean;
  message: string;
  out_trade_no: string;
  payment_type: PaymentType;
  code_url?: string;        // Native支付返回
  notify_url_used?: string;
  created_at: string;
  expires_at: string;
}

// 错误响应接口
interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  detail?: string;
}

// 工具函数
function createErrorResponse(error: string, code?: string, detail?: string, status: number = 400): Response {
  const errorResponse: ErrorResponse = { success: false, error, code, detail };
  return new Response(JSON.stringify(errorResponse), { 
    status, 
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Content-Type': 'application/json',
    }
  });
}

function createSuccessResponse(data: CreatePaymentResponse): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Content-Type': 'application/json',
    }
  });
}

// 生成随机字符串
function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}


// 验证支付类型参数
function validatePaymentRequest(req: CreatePaymentRequest): string | null {
  if (!req.out_trade_no) {
    return 'out_trade_no is required';
  }
  
  return null;
}

// 创建支付记录到数据库
async function createPaymentRecord(
  outTradeNo: string, 
  paymentType: PaymentType, 
  amount: number,
  notifyUrl?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const paymentData = {
      out_trade_no: outTradeNo,
      payment_type: paymentType,
      amount: amount,
      status: 'pending',
      notify_url: notifyUrl,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30分钟后过期
    };

    const { error } = await supabase
      .from('payments')
      .insert(paymentData);

    if (error) {
      console.error('Failed to create payment record:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    console.error('Error creating payment record:', err);
    return { success: false, error: 'Database error' };
  }
}

// 微信支付 v3 API 相关函数
interface WechatPayConfig {
  merchantId: string;
  appId: string;
  mchCertificateSerialNo: string;
  mchApiV3Key: string;
  mchPrivateKeyPem: string;
}

interface WechatPayResponse {
  code_url?: string;
  error?: {
    code: string;
    message: string;
  };
}

// 将PKCS8 PEM解析为CryptoKey
async function importPrivateKeyFromPem(pem: string): Promise<CryptoKey> {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.replace(/\r?\n/g, "\n").split(pemHeader).pop()?.split(pemFooter)[0]?.replace(/\s+/g, "") ?? "";
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// 生成微信支付v3签名（RSA-SHA256）
async function generateWechatPayRSASignature(
  method: string,
  url: string,
  timestamp: string,
  nonce: string,
  body: string,
  mchPrivateKeyPem: string,
): Promise<string> {
  const signString = `${method}\n${url}\n${timestamp}\n${nonce}\n${body}\n`;
  const privateKey = await importPrivateKeyFromPem(mchPrivateKeyPem);
  const signatureBuf = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signString),
  );
  return base64Encode(new Uint8Array(signatureBuf));
}

// 调用微信支付 Native 支付 API
async function callWechatPayNative(
  config: WechatPayConfig,
  outTradeNo: string,
  amount: number,
  description: string,
  notifyUrl: string
): Promise<WechatPayResponse> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateRandomString(32);
  const url = '/v3/pay/transactions/native';
  
  const requestBody = {
    appid: config.appId,
    mchid: config.merchantId,
    description: description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: {
      total: Math.round(amount * 100) // 转换为分
    }
  };
  
  const bodyString = JSON.stringify(requestBody);
  
  try {
    // 生成RSA签名
    const signature = await generateWechatPayRSASignature(
      'POST',
      url,
      timestamp,
      nonce,
      bodyString,
      config.mchPrivateKeyPem,
    );
    
    // 构建 Authorization 头（v3要求：WECHATPAY2-SHA256-RSA2048）
    const authString = `WECHATPAY2-SHA256-RSA2048 mchid="${config.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.mchCertificateSerialNo}",signature="${signature}"`;
    
    console.log('WeChat Pay API Request:', {
      url: `https://api.mch.weixin.qq.com${url}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authString,
        'Accept': 'application/json',
        'User-Agent': 'miaoda-pay-be/1.0.0'
      },
      body: requestBody
    });
    
    const response = await fetch(`https://api.mch.weixin.qq.com${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authString,
        'Accept': 'application/json',
        'User-Agent': 'miaoda-pay-be/1.0.0'
      },
      body: bodyString
    });
    
    const responseData = await response.json();
    console.log('WeChat Pay API Response:', responseData);
    
    if (response.ok) {
      return {
        code_url: responseData.code_url
      };
    } else {
      return {
        error: {
          code: responseData.code || 'UNKNOWN_ERROR',
          message: responseData.message || 'WeChat Pay API error'
        }
      };
    }
  } catch (error) {
    console.error('WeChat Pay API call failed:', error);
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: error.message || 'Network error'
      }
    };
  }
}


serve(async (req) => {
  console.log("create-payment function called");
  
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  try {
    // 只允许 POST 请求
    if (req.method !== 'POST') {
      return createErrorResponse('Method not allowed', 'METHOD_NOT_ALLOWED', undefined, 405);
    }

    // 解析请求体
    const body = await req.json().catch(() => ({} as any));
    console.log('Request body:', body);

    // 验证请求参数
    const validationError = validatePaymentRequest(body);
    if (validationError) {
      return createErrorResponse(validationError, 'INVALID_REQUEST');
    }

    const request: CreatePaymentRequest = {
      out_trade_no: body.out_trade_no,
      notify_url: body.notify_url ?? DEFAULT_NOTIFY_URL,
      payment_type: body.payment_type ?? PaymentType.NATIVE
    };

    console.log('Processing payment request:', request);

    // 查询订单信息
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('out_trade_no, total_amount, status, user_id, merchant_id, sku_items')
      .eq('out_trade_no', request.out_trade_no)
      .limit(1)
      .maybeSingle();

    if (orderErr) {
      console.error('Order query failed:', orderErr);
      return createErrorResponse('Failed to query order', 'ORDER_QUERY_FAILED', orderErr.message, 500);
    }

    if (!order) {
      return createErrorResponse('Order not found', 'ORDER_NOT_FOUND', undefined, 404);
    }

    if (order.status !== 'pending') {
      return createErrorResponse('Order is not pending', 'ORDER_NOT_PENDING', `Current status: ${order.status}`, 409);
    }

    console.log('Order found:', order);

    // 检查是否已有进行中的支付
    const { data: existingPayment } = await supabase
      .from('payments')
      .select('id, status, created_at')
      .eq('out_trade_no', request.out_trade_no)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();

    if (existingPayment) {
      const createdAt = new Date(existingPayment.created_at);
      const now = new Date();
      const diffMinutes = (now.getTime() - createdAt.getTime()) / (1000 * 60);
      
      if (diffMinutes < 30) { // 30分钟内的重复请求
        return createErrorResponse('Payment already in progress', 'PAYMENT_IN_PROGRESS', 
          `Payment created at ${createdAt.toISOString()}`, 409);
      }
    }

    // 已移除 Mock 模式，始终走真实微信支付

    // 真实微信支付模式
    console.log('Using real WeChat payment');
    
    // 校验商户配置
    if (!MERCHANT_ID || !MERCHANT_APP_ID || !MCH_CERT_SERIAL_NO || !MCH_APIV3_KEY || !MCH_PRIVATE_KEY) {
      return createErrorResponse('Merchant configuration incomplete', 'MERCHANT_CONFIG_INCOMPLETE', 
        'Missing required environment variables', 500);
    }

    // 构建微信支付配置
    const wechatPayConfig: WechatPayConfig = {
      merchantId: MERCHANT_ID,
      appId: MERCHANT_APP_ID,
      mchCertificateSerialNo: MCH_CERT_SERIAL_NO,
      mchApiV3Key: MCH_APIV3_KEY,
      mchPrivateKeyPem: MCH_PRIVATE_KEY
    };

    // 只支持 Native 支付
    if (request.payment_type !== PaymentType.NATIVE) {
      return createErrorResponse('Only Native payment is supported', 'UNSUPPORTED_PAYMENT_TYPE');
    }

    // 调用微信支付 Native API
    const description = `订单支付-${request.out_trade_no}`;
    const notifyUrl = request.notify_url || DEFAULT_NOTIFY_URL || '';

    try {
      const wechatResponse = await callWechatPayNative(
        wechatPayConfig,
        request.out_trade_no,
        order.total_amount,
        description,
        notifyUrl
      );

      // 检查微信支付 API 响应
      if (wechatResponse.error) {
        console.error('WeChat Pay API error:', wechatResponse.error);
        return createErrorResponse(
          'WeChat Pay API error', 
          'WECHAT_PAY_ERROR', 
          `${wechatResponse.error.code}: ${wechatResponse.error.message}`, 
          500
        );
      }

      // 构建成功响应
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30分钟后过期
      
      const responseData: CreatePaymentResponse = {
        success: true,
        message: 'Native payment created successfully',
        out_trade_no: request.out_trade_no,
        payment_type: PaymentType.NATIVE,
        code_url: wechatResponse.code_url,
        notify_url_used: notifyUrl,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString()
      };

      // 创建支付记录
      const paymentRecord = await createPaymentRecord(
        request.out_trade_no,
        PaymentType.NATIVE,
        order.total_amount,
        notifyUrl
      );

      if (!paymentRecord.success) {
        console.error('Failed to create payment record:', paymentRecord.error);
        responseData.message += ' (Payment record creation failed)';
      }

      console.log('Real WeChat payment response:', responseData);
      return createSuccessResponse(responseData);

    } catch (error) {
      console.error('Real WeChat payment failed:', error);
      return createErrorResponse(
        'WeChat payment creation failed', 
        'WECHAT_PAY_CREATION_FAILED', 
        error?.message || 'Unknown error', 
        500
      );
    }

  } catch (error: any) {
    console.error('Unexpected error in create-payment:', error);
    return createErrorResponse(
      'Internal server error', 
      'INTERNAL_ERROR', 
      error?.message ?? String(error), 
      500
    );
  }
});