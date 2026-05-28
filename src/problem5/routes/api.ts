import { Router } from "express";
import { postController } from "../controllers/postController";
import { writeLimiter } from "../middleware/rateLimit";

export const apiRouter = Router();

apiRouter.get("/posts", postController.list);
apiRouter.get("/posts/:id", postController.show);
apiRouter.post("/posts", writeLimiter, postController.create);
apiRouter.patch("/posts/:id", writeLimiter, postController.update);
apiRouter.delete("/posts/:id", writeLimiter, postController.destroy);
