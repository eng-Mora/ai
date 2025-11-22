document.getElementById("askBtn").addEventListener("click", async () => {
    const question = document.getElementById("question").value;
    const answerDiv = document.getElementById("answer");
    answerDiv.innerText = "جاري التحميل...";

    const API_KEY = "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";

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content: question }]
            })
        });

        const data = await response.json();
        answerDiv.innerText = data.choices[0].message.content;
    } catch (error) {
        answerDiv.innerText = "حدث خطأ، حاول مرة أخرى";
        console.error(error);
    }
});
