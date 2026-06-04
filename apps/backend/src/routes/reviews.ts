import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { verifyToken, AuthRequest } from '../middleware/auth';
import { OpenAI } from 'openai';

const router = Router();
const prisma = new PrismaClient();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Validation schemas
const GenerateReviewSchema = z.object({
  businessId: z.string().min(1, 'Business ID is required'),
  tone: z.enum(['professional', 'casual', 'enthusiastic', 'grateful']).optional().default('professional'),
  length: z.enum(['short', 'medium', 'long']).optional().default('medium'),
  rating: z.number().min(1).max(5).optional().default(5),
  focus: z.array(z.string()).optional(),
});

const UpdateReviewSchema = z.object({
  content: z.string().min(10, 'Review must be at least 10 characters'),
  rating: z.number().min(1).max(5).optional(),
  status: z.enum(['DRAFT', 'PENDING', 'POSTED', 'FAILED', 'ARCHIVED']).optional(),
});

/**
 * @route   POST /api/reviews/generate
 * @desc    Generate AI review for a business
 * @access  Private
 */
router.post('/generate', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, tone, length, rating, focus } = GenerateReviewSchema.parse(req.body);

    // Verify business ownership
    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: req.userId,
      },
    });

    if (!business) {
      return res.status(404).json({
        error: 'Business not found',
        code: 'BUSINESS_NOT_FOUND',
      });
    }

    // Create prompt for AI
    const lengthGuide = {
      short: '50-75 words',
      medium: '100-150 words',
      long: '200-250 words',
    };

    const prompt = `Generate a ${tone} Google review for a ${business.category} business called "${business.name}". 
${business.description ? `Description: ${business.description}` : ''}
Rating: ${rating} out of 5 stars
Length: ${lengthGuide[length as keyof typeof lengthGuide]}
${focus?.length ? `Focus points: ${focus.join(', ')}` : ''}

Write only the review content without any additional text or quotes.`;

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that writes authentic, natural-sounding Google reviews.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
      max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '500'),
    });

    const content = completion.choices[0].message.content || '';

    // Save review to database
    const review = await prisma.review.create({
      data: {
        userId: req.userId,
        businessId,
        content,
        rating,
        status: 'DRAFT',
      },
    });

    res.status(201).json({
      message: 'Review generated successfully',
      data: { review },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: error.errors,
      });
    }

    console.error('Generate review error:', error);
    res.status(500).json({
      error: 'Failed to generate review',
      code: 'GENERATION_ERROR',
    });
  }
});

/**
 * @route   POST /api/reviews/batch/generate
 * @desc    Generate multiple reviews at once
 * @access  Private
 */
router.post('/batch/generate', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { businessId, count } = z.object({
      businessId: z.string(),
      count: z.number().min(1).max(10).optional().default(3),
    }).parse(req.body);

    // Verify business ownership
    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: req.userId,
      },
    });

    if (!business) {
      return res.status(404).json({
        error: 'Business not found',
        code: 'BUSINESS_NOT_FOUND',
      });
    }

    const generatedReviews = [];

    for (let i = 0; i < count; i++) {
      const prompt = `Generate a unique Google review for a ${business.category} business called "${business.name}".
${business.description ? `Description: ${business.description}` : ''}
Rating: 5 out of 5 stars
Length: 100-150 words

Write only the review content without any additional text or quotes. Make it unique from other reviews.`;

      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that writes authentic, natural-sounding Google reviews.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
        max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '500'),
      });

      const content = completion.choices[0].message.content || '';

      const review = await prisma.review.create({
        data: {
          userId: req.userId,
          businessId,
          content,
          rating: 5,
          status: 'DRAFT',
        },
      });

      generatedReviews.push(review);
    }

    res.status(201).json({
      message: `${count} reviews generated successfully`,
      data: { reviews: generatedReviews },
    });
  } catch (error) {
    console.error('Batch generate error:', error);
    res.status(500).json({
      error: 'Failed to generate reviews',
      code: 'GENERATION_ERROR',
    });
  }
});

/**
 * @route   GET /api/reviews
 * @desc    Get all reviews for authenticated user
 * @access  Private
 */
router.get('/', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { status, businessId } = req.query;

    const where: any = { userId: req.userId };
    if (status) where.status = status;
    if (businessId) where.businessId = businessId;

    const reviews = await prisma.review.findMany({
      where,
      include: {
        business: {
          select: { id: true, name: true, category: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      message: 'Reviews retrieved successfully',
      data: { reviews },
    });
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * @route   GET /api/reviews/:id
 * @desc    Get single review by ID
 * @access  Private
 */
router.get('/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const review = await prisma.review.findFirst({
      where: {
        id,
        userId: req.userId,
      },
      include: {
        business: true,
      },
    });

    if (!review) {
      return res.status(404).json({
        error: 'Review not found',
        code: 'REVIEW_NOT_FOUND',
      });
    }

    res.status(200).json({
      message: 'Review retrieved successfully',
      data: { review },
    });
  } catch (error) {
    console.error('Get review error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * @route   PUT /api/reviews/:id
 * @desc    Update review
 * @access  Private
 */
router.put('/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const data = UpdateReviewSchema.parse(req.body);

    // Verify ownership
    const review = await prisma.review.findFirst({
      where: {
        id,
        userId: req.userId,
      },
    });

    if (!review) {
      return res.status(404).json({
        error: 'Review not found',
        code: 'REVIEW_NOT_FOUND',
      });
    }

    const updatedReview = await prisma.review.update({
      where: { id },
      data,
      include: {
        business: true,
      },
    });

    res.status(200).json({
      message: 'Review updated successfully',
      data: { review: updatedReview },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: error.errors,
      });
    }

    console.error('Update review error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * @route   DELETE /api/reviews/:id
 * @desc    Delete review
 * @access  Private
 */
router.delete('/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const review = await prisma.review.findFirst({
      where: {
        id,
        userId: req.userId,
      },
    });

    if (!review) {
      return res.status(404).json({
        error: 'Review not found',
        code: 'REVIEW_NOT_FOUND',
      });
    }

    await prisma.review.delete({
      where: { id },
    });

    res.status(200).json({
      message: 'Review deleted successfully',
    });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * @route   POST /api/reviews/:id/post
 * @desc    Post review to Google Business Profile
 * @access  Private
 */
router.post('/:id/post', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const review = await prisma.review.findFirst({
      where: {
        id,
        userId: req.userId,
      },
      include: {
        business: true,
      },
    });

    if (!review) {
      return res.status(404).json({
        error: 'Review not found',
        code: 'REVIEW_NOT_FOUND',
      });
    }

    // TODO: Implement Google Business Profile API integration
    // For now, just update status to POSTED
    const postedReview = await prisma.review.update({
      where: { id },
      data: {
        status: 'POSTED',
        postedAt: new Date(),
      },
      include: {
        business: true,
      },
    });

    res.status(200).json({
      message: 'Review posted to Google Business Profile',
      data: { review: postedReview },
    });
  } catch (error) {
    console.error('Post review error:', error);
    res.status(500).json({
      error: 'Failed to post review',
      code: 'POST_ERROR',
    });
  }
});

export default router;
