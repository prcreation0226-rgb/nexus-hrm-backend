require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

async function test() {
    console.log("Starting test...");
    const apiKey = 'AIzaSyFakeKey1234567890';
    const modelName = 'gemini-pro';
    console.log(`Using Key: ${apiKey.substring(0, 5)}...`);
    console.log(`Using Model: ${modelName}`);

    const ai = new GoogleGenAI({ apiKey });
    const startTime = Date.now();
    try {
        console.log("Sending request...");
        const response = await ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: 'Hello, what is your name?' }] }]
        });
        const duration = Date.now() - startTime;
        console.log(`Response received in ${duration}ms!`);
        console.log("Response text:", response.candidates[0].content.parts[0].text);
    } catch (err) {
        const duration = Date.now() - startTime;
        console.error(`Error after ${duration}ms:`, err.message);
    }
}

test();
