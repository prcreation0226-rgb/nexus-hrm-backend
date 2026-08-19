const axios = require('axios');

/**
 * Format phone number to WhatsApp E.164 international format without + or spaces
 * Automatically handles 10-digit local numbers by adding default country code
 * e.g. "9876543210" -> "919876543210", "+65 9123 4567" -> "6591234567"
 */
function formatPhoneNumber(phone, defaultCountryCode = '91') {
    if (!phone) return null;
    let cleaned = String(phone).replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }
    // Remove leading 0 if someone entered e.g. 09876543210
    if (cleaned.startsWith('0') && cleaned.length === 11) {
        cleaned = cleaned.substring(1);
    }

    const code = String(defaultCountryCode || '91').replace(/[^\d]/g, '') || '91';

    // If it already has country code (11 to 15 digits), keep it
    if (cleaned.length >= 11 && !cleaned.startsWith('0')) {
        return cleaned;
    }
    // If it's a standard 10-digit number without country code
    if (cleaned.length === 10) {
        return `${code}${cleaned}`;
    }
    // If it's an 8-digit Singapore number (starts with 8 or 9)
    if (cleaned.length === 8 && (cleaned.startsWith('8') || cleaned.startsWith('9'))) {
        return code === '65' ? `65${cleaned}` : `${code}${cleaned}`;
    }
    return cleaned.length >= 7 ? `${code}${cleaned}` : null;
}

/**
 * Send a Payslip PDF document to an employee via WhatsApp Cloud API
 */
async function sendWhatsAppDocument({
    phoneNumberId,
    accessToken,
    toPhone,
    defaultCountryCode = '91',
    documentUrl,
    fileName,
    caption,
    templateName = 'payslip_delivery',
    templateParams = {}
}) {
    const formattedPhone = formatPhoneNumber(toPhone, defaultCountryCode);
    if (!formattedPhone) {
        throw new Error('Employee WhatsApp number is not available or invalid.');
    }

    if (!phoneNumberId || !accessToken) {
        throw new Error('WhatsApp integration is not configured.');
    }

    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    const docFileName = fileName || 'Payslip.pdf';
    const monthYear = templateParams.monthYear || 'Recent Period';
    const employeeName = templateParams.employeeName || 'Employee';

    // 1. Try Template Message first (required by WhatsApp for outbound 24h window)
    if (templateName && templateName.trim() !== '') {
        try {
            const templatePayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: formattedPhone,
                type: 'template',
                template: {
                    name: templateName.trim(),
                    language: { code: 'en' },
                    components: [
                        {
                            type: 'header',
                            parameters: [
                                {
                                    type: 'document',
                                    document: {
                                        link: documentUrl,
                                        filename: docFileName
                                    }
                                }
                            ]
                        },
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: employeeName },
                                { type: 'text', text: monthYear }
                            ]
                        }
                    ]
                }
            };

            const response = await axios.post(url, templatePayload, { headers, timeout: 15000 });
            return {
                success: true,
                messageId: response.data?.messages?.[0]?.id || 'WAMID_SUCCESS',
                mode: 'template'
            };
        } catch (templateErr) {
            console.warn('⚠️ WhatsApp Template send failed, falling back to direct document:', templateErr.response?.data || templateErr.message);
            // If template not found or parameter mismatch, fall through to direct document attempt
        }
    }

    // 2. Direct Document Message
    try {
        const directPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: formattedPhone,
            type: 'document',
            document: {
                link: documentUrl,
                caption: caption || `Hello ${employeeName},\n\nYour payslip for ${monthYear} is ready. Please find attached.\n\nThank you!`,
                filename: docFileName
            }
        };

        const response = await axios.post(url, directPayload, { headers, timeout: 15000 });
        return {
            success: true,
            messageId: response.data?.messages?.[0]?.id || 'WAMID_SUCCESS',
            mode: 'direct'
        };
    } catch (err) {
        const metaError = err.response?.data?.error;
        let errorMessage = 'Unable to send WhatsApp payslip. Please try again.';
        
        if (metaError) {
            if (metaError.code === 190) {
                errorMessage = 'Meta WhatsApp Access Token has expired or is invalid.';
            } else if (metaError.code === 100) {
                errorMessage = `Invalid WhatsApp parameters: ${metaError.message}`;
            } else if (metaError.code === 131030) {
                errorMessage = `Recipient phone ${formattedPhone} is not a valid WhatsApp account.`;
            } else if (metaError.message) {
                errorMessage = metaError.message;
            }
        } else if (err.message) {
            errorMessage = err.message;
        }

        console.error('❌ WhatsApp Send Error:', errorMessage);
        throw new Error(errorMessage);
    }
}

/**
 * Send a direct test text message or verify token
 */
async function testWhatsAppConnection({ phoneNumberId, accessToken, testPhone }) {
    if (!phoneNumberId || !accessToken) {
        throw new Error('Phone Number ID and Access Token are required.');
    }

    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    // 1. Verify Phone Number ID & Token with Meta Graph API
    try {
        const checkUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}`;
        const checkRes = await axios.get(checkUrl, { headers, timeout: 10000 });
        const phoneInfo = checkRes.data;

        // 2. If test phone provided, send a text message
        if (testPhone) {
            const formatted = formatPhoneNumber(testPhone);
            if (!formatted) {
                throw new Error('Test phone number is invalid. Please include country code.');
            }

            const sendUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
            const textPayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: formatted,
                type: 'text',
                text: {
                    preview_url: false,
                    body: '✅ Test Message: Your HRM WhatsApp Integration is connected and working perfectly!'
                }
            };

            await axios.post(sendUrl, textPayload, { headers, timeout: 15000 });
            return {
                success: true,
                message: `Connection successful! Verified phone: ${phoneInfo.display_phone_number || phoneNumberId}. Test message sent to +${formatted}.`,
                phoneInfo
            };
        }

        return {
            success: true,
            message: `Connection verified successfully with Meta WhatsApp API! Display number: ${phoneInfo.display_phone_number || phoneInfo.id}.`,
            phoneInfo
        };
    } catch (err) {
        const metaError = err.response?.data?.error;
        const msg = metaError?.message || err.message || 'Failed to connect to Meta WhatsApp API.';
        throw new Error(msg);
    }
}

/**
 * Rate-limited batch dispatcher
 * Runs in chunks of 5 with 300ms delay between chunks to avoid HTTP 429
 */
async function sendBatchWithRateLimit(items, handlerFn, { concurrency = 5, delayMs = 300 } = {}) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkPromises = chunk.map(item => handlerFn(item));
        const chunkResults = await Promise.allSettled(chunkPromises);
        results.push(...chunkResults);

        // Delay between chunks if more items remain
        if (i + concurrency < items.length && delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return results;
}

module.exports = {
    formatPhoneNumber,
    sendWhatsAppDocument,
    testWhatsAppConnection,
    sendBatchWithRateLimit
};
