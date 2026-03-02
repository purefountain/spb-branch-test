console.log("Hello from Functions!");

Deno.serve(async (req) => {


  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  const data = {
    message: `Hello world! \n ${supabaseUrl} `,
  };



  return new Response(
    JSON.stringify(data),
    {
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
});